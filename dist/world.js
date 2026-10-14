import { entityIndex, entityGen, packEntity, GEN_BITS, GEN_MASK, INDEX_MASK, } from "./entity.js";
import { _kindOrder, _kindIds, _schemas } from "./component.js";
import { ObjectColumn, Float64Column, asObjectColumn } from "./storage.js";
import { QueryState } from "./query.js";
// ═══════════════════════════════════════════════════════════
// World
// ═══════════════════════════════════════════════════════════
/** Build a stable archetype key from sorted kind names. */
function _typeKey(kinds) {
    return [...kinds].sort().join("\x00");
}
/** Query 候选缓存阈值：组件所在 archetype 数 ≤ 此值时交集很便宜，
 *  直接算（避免缓存固定开销导致的负提升）；大于才走 Bevy QueryState 缓存。 */
const CACHE_THRESHOLD = 16;
export class World {
    // ══════════════════════════════════════════════════
    //  Public API — Entity lifecycle
    // ══════════════════════════════════════════════════
    /**
     * Reserve an entity ID without placing it in any archetype.
     * Entity is alive immediately (isAlive() → true) but has zero components —
     * getComponent() returns undefined, queries won't see it.
     * Used by Commands.spawn() for immediate entity reservation with deferred archetype allocation.
     */
    reserveEntity() {
        let index;
        if (this._freeSlots.length > 0) {
            index = this._freeSlots.pop();
        }
        else {
            if (this._nextSlot > INDEX_MASK) {
                throw new Error(`[ecs] entity index space exhausted (max ${INDEX_MASK + 1} slots)`);
            }
            index = this._nextSlot++;
        }
        if (index >= this._gens.length) {
            const oldGen = this._gens;
            const newCap = Math.max(index + 256, this._gens.length * 2);
            const next = new Uint16Array(newCap);
            next.set(oldGen);
            this._gens = next;
            this._genState.gens = next;
        }
        let gen = (this._gens[index] + 1) & GEN_MASK;
        if (gen === 0)
            gen = 1;
        this._gens[index] = gen;
        this._entityCount++;
        return packEntity(index, gen);
    }
    /**
     * @internal Complete a deferred spawn — add components to a pre-reserved entity.
     * Called by Commands during applyCommands() flush. Does NOT allocate a new entity ID.
     */
    _finishSpawn(entity, components) {
        if (components.length === 0)
            return;
        const kinds = [...new Set(components.map((c) => c.type))].sort();
        const tick = this._nextTick();
        const arch = this._findOrCreateArchetype(kinds);
        const row = arch.entities.length;
        arch.entities.push(entity);
        const kindMap = new Map(components.map((c) => [c.type, c]));
        const dataByKind = this.hasChangedHooks && kinds.some((kind) => this.changedHooks.get(kind)?.size)
            ? new Map()
            : undefined;
        for (let ci = 0; ci < kinds.length; ci++) {
            const kind = kinds[ci];
            const c = kindMap.get(kind);
            const { type: _type, ...data } = c;
            dataByKind?.set(kind, data);
            arch.columns[ci].push(data);
            arch.addedTicks[ci].push(tick);
            arch.changedTicks[ci].push(tick);
            this._lastChangedTick.set(kind, tick);
        }
        this._entityIndex.set(entity, { archetypeId: arch.id, row });
        for (const kind of kinds) {
            const addHooks = this._onAddHooks.get(kind);
            if (addHooks?.size)
                this._fireHooks(addHooks, entity);
            const hooks = this.changedHooks.get(kind);
            if (dataByKind && hooks?.size)
                this._fireHooks(hooks, entity, dataByKind.get(kind));
        }
    }
    /**
     * Create an entity with components.
     * Immediate mode — entity is queryable on return. For deferred spawn, use Commands.
     */
    spawn(components, overrides) {
        const entity = this.reserveEntity();
        const cs = components ?? [];
        let merged;
        if (overrides) {
            merged = cs.map((c) => {
                const patch = overrides[c.type];
                return patch ? { ...c, ...patch } : c;
            });
            for (const [kind, data] of Object.entries(overrides)) {
                if (!cs.some((c) => c.type === kind)) {
                    merged.push({ type: kind, ...data });
                }
            }
        }
        else {
            merged = cs;
        }
        if (merged.length > 0)
            this._finishSpawn(entity, merged);
        return entity;
    }
    /** Mark an entity as destroyed. Before-destroy hooks fire before generation bump —
     *  all components are still fully readable. _pendingDestroy prevents re-entrant cascade loops.
     *  Johnson §3.2 p53: finalizer callbacks synchronized with lifecycle phases. */
    destroy(entity) {
        if (!this.isAlive(entity))
            return;
        if (this._pendingDestroy?.has(entity))
            return;
        (this._pendingDestroy ?? (this._pendingDestroy = new Set())).add(entity);
        for (const callback of this._onBeforeDestroyHooks) {
            try {
                callback(entity);
            }
            catch (error) {
                console.error("[ecs] lifecycle hook failed:", error);
            }
        }
        this._pendingDestroy.delete(entity);
        const idx = entityIndex(entity);
        const currentGen = this._gens[idx];
        if (currentGen >= GEN_MASK) {
            // Generation exhausted: retire the slot instead of wrapping to gen 1,
            // which would silently revive stale handles.
            this._gens[idx] = 0;
        }
        else {
            this._gens[idx] = currentGen + 1;
            this._freeSlots.push(idx);
        }
        this._entityCount--;
        this._deferredDestroys.push(entity);
    }
    /** Register a before-destroy callback. Returns an unsubscribe function. */
    onBeforeDestroy(cb) {
        this._onBeforeDestroyHooks.add(cb);
        return () => {
            this._onBeforeDestroyHooks.delete(cb);
        };
    }
    // ── Entity name registry ──
    /**
     * Register an on_add hook for a component kind (Bevy-aligned).
     * Fires when the component is **first added** to an entity that didn't have it.
     * Spawning an entity with the component triggers on_add.
     */
    onAdd(factory, cb) {
        const kind = typeof factory === "string" ? factory : factory.kind;
        let hooks = this._onAddHooks.get(kind);
        if (!hooks) {
            hooks = new Set();
            this._onAddHooks.set(kind, hooks);
        }
        hooks.add(cb);
        return () => {
            hooks.delete(cb);
        };
    }
    /**
     * Register an on_remove hook for a component kind (Bevy-aligned).
     * Fires when the component is **removed** from an entity.
     * Destroying an entity triggers on_remove for each of its components.
     */
    onRemove(factory, cb) {
        const kind = typeof factory === "string" ? factory : factory.kind;
        let hooks = this._onRemoveHooks.get(kind);
        if (!hooks) {
            hooks = new Set();
            this._onRemoveHooks.set(kind, hooks);
        }
        hooks.add(cb);
        return () => {
            hooks.delete(cb);
        };
    }
    /**
     * Register a component-change hook.
     *
     * Runs exactly once for each completed insert or replacement of an existing
     * component. It does not run for removals. Hooks are isolated: one throwing
     * callback does not prevent the remaining callbacks or the structural write.
     */
    onChanged(factory, cb) {
        const kind = typeof factory === "string" ? factory : factory.kind;
        let hooks = this.changedHooks.get(kind);
        if (!hooks) {
            hooks = new Set();
            this.changedHooks.set(kind, hooks);
        }
        hooks.add(cb);
        this.hasChangedHooks = true;
        return () => {
            hooks.delete(cb);
            if (hooks.size === 0) {
                this.hasChangedHooks = [...this.changedHooks.values()].some((set) => set.size > 0);
            }
        };
    }
    /** Alias for onChanged — the component was set/inserted. */
    onSet(factory, cb) {
        return this.onChanged(factory, cb);
    }
    /** Returns true if the entity is alive. O(1) generation comparison (Gregory §17.5 handle pattern). */
    isAlive(entity) {
        // gen 0 is the NULL_ENTITY/retired-slot sentinel and is never a live handle.
        // Live entity indices are always < _gens.length (reserveEntity grows first);
        // forged/out-of-range handles read `undefined`, which never equals a gen.
        const gen = entityGen(entity);
        return gen !== 0 && this._gens[entityIndex(entity)] === gen;
    }
    entityCount() {
        return this._entityCount;
    }
    insertResource(factory, data) {
        if ("_comp" in factory) {
            // ResourceFactory — entity-based storage with automatic tick tracking
            const rf = factory;
            const entity = this._resourceEntities.get(rf.kind);
            const comp = rf._comp({ _value: data });
            if (entity && this.isAlive(entity)) {
                this.setComponent(entity, comp);
            }
            else {
                const newEntity = this.spawn([comp]);
                this._resourceEntities.set(rf.kind, newEntity);
            }
        }
        else {
            this._resources.set(factory.kind, data);
        }
    }
    /** Read a world resource. Returns undefined if the resource hasn't been inserted. */
    resource(factory) {
        if ("_comp" in factory) {
            const entity = this._resourceEntities.get(factory.kind);
            if (!entity)
                return undefined;
            const comp = this.getComponent(entity, factory._comp);
            return comp?._value;
        }
        return this._resources.get(factory.kind);
    }
    /** Remove a world resource. No-op if it doesn't exist. */
    removeResource(factory) {
        if ("_comp" in factory) {
            const entity = this._resourceEntities.get(factory.kind);
            if (entity) {
                this.destroy(entity);
                this._resourceEntities.delete(factory.kind);
            }
        }
        else {
            this._resources.delete(factory.kind);
        }
    }
    /** Check whether a world resource has been inserted. */
    hasResource(factory) {
        if ("_comp" in factory) {
            const entity = this._resourceEntities.get(factory.kind);
            return entity !== undefined && this.isAlive(entity);
        }
        return this._resources.has(factory.kind);
    }
    /**
     * Check whether a resource changed since the last time this observer (system) checked.
     * Uses the Engine-set `_currentObserver` for automatic per-system tick tracking.
     *
     * ```ts
     * // In any system.update():
     * if (!world.resourceChanged(DataStore)) return; // skip work if unchanged
     * ```
     */
    resourceChanged(factory) {
        const entity = this._resourceEntities.get(factory.kind);
        if (!entity)
            return false;
        const entry = this._getComponentEntryRaw(entity, factory.kind);
        if (!entry)
            return false;
        const tick = entry.changedTick;
        const observer = this._currentObserver ?? "__global__";
        let obsMap = this._seenResourceTicks.get(observer);
        if (!obsMap) {
            obsMap = new Map();
            this._seenResourceTicks.set(observer, obsMap);
        }
        const lastSeen = obsMap.get(factory.kind) ?? 0;
        obsMap.set(factory.kind, tick);
        return tick > lastSeen;
    }
    /**
     * Manually bump a resource's changedTick without changing its data.
     * Needed when the resource data is mutated in-place (e.g. Map.set()) without going through setComponent.
     */
    markResourceChanged(factory) {
        const entity = this._resourceEntities.get(factory.kind);
        if (!entity)
            return;
        const raw = this._getComponentRaw(entity, factory.kind);
        if (!raw)
            return;
        // Re-write the same data to bump changedTick (same mechanism as setComponent)
        this._writeComponent(entity, { type: factory.kind, ...raw });
    }
    // ══════════════════════════════════════════════════
    //  Public API — Component operations
    // ══════════════════════════════════════════════════
    addComponent(entity, component) {
        if (!this.isAlive(entity))
            return;
        this._writeComponent(entity, component);
    }
    setComponent(entity, component) {
        if (!this.isAlive(entity))
            return;
        this._writeComponent(entity, component);
    }
    patchComponent(entity, factory, patch) {
        if (!this.isAlive(entity))
            return;
        const existing = this.getComponent(entity, factory);
        if (existing) {
            this.setComponent(entity, factory.create({ ...existing, ...patch }));
        }
        else {
            this.setComponent(entity, factory.create(patch));
        }
    }
    /**
     * 批量写组件（Story P0-04）：对多实体应用同 patch（或 per-entity patch 数组），
     * 按 archetype 分组列级直写——Float64Column 数值字段 TypedArray 直写（零装箱）。
     * 语义与逐实体 setComponent 一致（同 tick、触发 Changed）。跳过无此组件的实体。
     * @returns 实际写入的实体数
     */
    setComponents(factory, entities, patch) {
        const kind = factory.kind;
        // 按 archetype 分组（同列可批量写）
        const groups = new Map();
        let written = 0;
        for (let i = 0; i < entities.length; i++) {
            const e = entities[i];
            if (!this.isAlive(e))
                continue;
            const rec = this._entityIndex.get(e);
            if (!rec)
                continue;
            const colIdx = this._componentIndex.get(kind)?.get(rec.archetypeId);
            if (colIdx === undefined)
                continue; // 实体无此组件——跳过（批量更新已有）
            const p = (Array.isArray(patch) ? patch[i] : patch);
            let g = groups.get(rec.archetypeId);
            if (!g) {
                g = { rows: [], values: [] };
                groups.set(rec.archetypeId, g);
            }
            g.rows.push(rec.row);
            g.values.push(p);
            written++;
        }
        if (written === 0)
            return 0;
        const tick = this._nextTick();
        for (const [archId, g] of groups) {
            const arch = this._archetypes.get(archId);
            const colIdx = this._componentIndex.get(kind).get(archId);
            const col = arch.columns[colIdx];
            const isF64 = col.isFloat64 === true;
            const hooks = this.changedHooks.get(kind);
            const hasHooks = this.hasChangedHooks && hooks !== undefined && hooks.size > 0;
            for (let i = 0; i < g.rows.length; i++) {
                const row = g.rows[i];
                const p = g.values[i];
                let nextData;
                if (isF64) {
                    // Float64 快路径：数值字段直写 TypedArray（零装箱）
                    const fcol = col;
                    for (const name of Object.keys(p)) {
                        const arr = fcol.field(name);
                        if (arr)
                            arr[row] = p[name];
                    }
                    if (hasHooks)
                        nextData = fcol.get(row);
                }
                else {
                    const data = col.get(row);
                    for (const name of Object.keys(p))
                        data[name] = p[name];
                    col.set(row, data);
                    nextData = data;
                }
                arch.changedTicks[colIdx][row] = tick;
                this._lastChangedTick.set(kind, tick);
                if (hasHooks)
                    this._fireHooks(hooks, arch.entities[row], nextData);
            }
        }
        return written;
    }
    /** Read a component. O(1): entity_index → archetype + row → component_index → column[row].
     *  Mertens: two map lookups + one array access. */
    getComponent(entity, factory) {
        return this._getComponentRaw(entity, factory.kind);
    }
    /** Read a component entry with its ticks. */
    getComponentEntry(entity, factory) {
        return this._getComponentEntryRaw(entity, factory.kind);
    }
    /** Check whether an entity has a component of the given factory's kind. */
    hasComponent(entity, factory) {
        return this._hasComponentInternal(entity, factory.kind);
    }
    /** Remove a component from an entity. */
    removeComponent(entity, factory) {
        if (!this.isAlive(entity))
            return;
        this._deleteComponent(entity, factory.kind);
    }
    /**
     * Create independent Changed/Added cursors for a persistent query reader.
     * QueryState is caller-owned; call forget()/clear() when retiring a long-lived
     * reader, or use a query whose state lifetime matches the reader.
     */
    createQueryState() {
        return new QueryState();
    }
    constructor() {
        this._tick = 0;
        this._entityCount = 0;
        // ── Entity allocator / generation table (per-World isolation) ──
        this._gens = new Uint16Array(256);
        /** Stable holder for query iterators: growth replaces gens without staling captured views. */
        this._genState = { gens: this._gens };
        this._freeSlots = [];
        this._nextSlot = 0;
        // ── Archetype column storage (Mertens Building ECS #1+#2) ──
        this._entityIndex = new Map();
        this._archetypes = new Map();
        this._componentIndex = new Map(); // kind → (archetypeId → colIdx)
        this._archetypeIndex = new Map(); // typeKey → archetypeId
        this._nextArchetypeId = 0;
        /** Archetype 结构代际——新增 archetype 时 +1，用于 query 候选缓存失效。 */
        this._archetypeGeneration = 0;
        /** Query 候选缓存：key = factories+With+Without → { 代际, 匹配 archetype 集 }。
         *  稳态（无新 archetype）下消除每次 query 的交集重算（Bevy QueryState 等价）。 */
        this._queryCache = new Map();
        // ── Deferred command buffer ──
        this._commands = [];
        // ── World resources (Bevy-style Res<T>) ──
        /** Resource-kind → singleton entity. ResourceFactory resources are components on dedicated entities. */
        this._resourceEntities = new Map();
        /** Per-observer per-resource-kind last-seen changedTick. Auto-managed by resourceChanged(). */
        this._seenResourceTicks = new Map();
        /** Fallback storage for ComponentFactory-based resources (backward compat). */
        this._resources = new Map();
        // ── Deferred destroy batching ──
        this._deferredDestroys = [];
        /** Entities killed this frame. Populated by _flushDestroys; reset at frame end (setCurrentObserver(null)). */
        this._killedThisFrame = [];
        /** 上一帧 kill——Bevy RemovedComponents 双缓冲：kill 事件存活 2 帧，
         *  保证「排在 killer 之前」的系统下帧仍能看到（帧内排序无关）。 */
        this._killedPrevFrame = [];
        /** Per-observer consumed count into 逻辑流 [prev, thisFrame]（多读者游标）。 */
        this._killedCursor = new Map();
        this._onBeforeDestroyHooks = new Set();
        // ── Component lifecycle hooks (Bevy-aligned: on_add / on_remove per component kind) ──
        /** Per-kind on_add hooks. Fires when a component type is added to an entity for the first time. */
        this._onAddHooks = new Map();
        /** Per-kind on_remove hooks. Fires when a component type is removed from an entity. */
        this._onRemoveHooks = new Map();
        /** Per-kind change hooks. Fires once for each completed insert/replace write. */
        this.changedHooks = new Map();
        /** Fast gate for the common no-hook write path. */
        this.hasChangedHooks = false;
        // ── Component removal tracking ──
        /** Removal tracking grouped to keep the World object shape compact. */
        this._removedState = {
            /** 本帧移除（帧末轮转进 prev）。 */
            buffer: [],
            /** 上一帧移除——Bevy RemovedComponents 事件双缓冲：与 drainKilled() 同一套 2 帧窗口语义。 */
            prev: [],
            /** 本帧已记录集合（同帧去重；帧末轮转时清空）。 */
            seen: [],
            cursors: new Map(),
        };
        /** Guards against re-entrant removal of the same entity/component pair. */
        this._removingComponents = new Set();
        /** Structural changes that invalidate stage skip-if-clean without a component tick. */
        this._structuralDirtyTick = 0;
        // ── Observer tracking ──
        this._currentObserver = null;
        /** Per-kind highest changedTick — enables O(kinds) isAnyDirty (Johnson Ch5.1 cache-friendly). */
        this._lastChangedTick = new Map();
        // Per-observer per-entity per-kind last-seen ticks
        this._seenAdded = new Map();
        this._seenChanged = new Map();
        // eslint-disable-next-line typescript/no-this-alias — needed for closure capture in ES5-compatible constructor
        const w = this;
        const queryFn = function (...factories) {
            if (factories.length === 0) {
                return {
                    forEach() { },
                    batch() { },
                    entities() {
                        return [];
                    },
                    first() {
                        return undefined;
                    },
                    filter() {
                        return this;
                    },
                    withState() {
                        return this;
                    },
                };
            }
            /** Intersect archetype maps of all factories + With filters, exclude Without.
             *  Seeds from the SMALLEST map (fewer membership checks). Returns empty set
             *  when no archetype qualifies; null when a component kind is unknown. */
            function computeCandidates(factories, withFilters, withoutFilters) {
                let smallest = null;
                for (const f of factories) {
                    const m = w._componentIndex.get(f.kind);
                    if (!m)
                        return null;
                    if (smallest === null || m.size < smallest.size)
                        smallest = m;
                }
                const candidate = new Set(smallest.keys());
                for (const f of factories) {
                    const m = w._componentIndex.get(f.kind);
                    if (m === smallest)
                        continue;
                    for (const id of candidate) {
                        if (!m.has(id))
                            candidate.delete(id);
                    }
                    if (candidate.size === 0)
                        return candidate;
                }
                for (const f of withFilters) {
                    const m = w._componentIndex.get(f.factory.kind);
                    if (!m)
                        return null;
                    for (const id of candidate) {
                        if (!m.has(id))
                            candidate.delete(id);
                    }
                    if (candidate.size === 0)
                        return candidate;
                }
                for (const f of withoutFilters) {
                    const m = w._componentIndex.get(f.factory.kind);
                    if (m) {
                        for (const id of candidate) {
                            if (m.has(id))
                                candidate.delete(id);
                        }
                        if (candidate.size === 0)
                            return candidate;
                    }
                }
                return candidate;
            }
            /** True when archetype rows may contain dead entities (destroy → flush window).
             *  When false, per-row isAlive checks are skipped entirely. */
            const aliveCheck = () => w._deferredDestroys.length > 0;
            /** Inline generation check — local Uint16Array ref, no method calls (JIT-friendly). */
            const isAliveFast = (e, genState) => genState.gens[(e >>> GEN_BITS) & INDEX_MASK] === (e & GEN_MASK);
            /** No-filter row loop, arity-specialized. Kept as a separate function so the
             *  JIT can optimize the hot loop independently of the large forEach body
             *  (measured: inlining it in forEach produced bimodal tiers — 2.5x faster
             *  or 1.45x slower than baseline depending on JIT luck). */
            function runFastRows(arch, colIdxs, needAlive, genState, cb) {
                const n = factories.length;
                const ents = arch.entities;
                const count = ents.length;
                let hasF64 = false;
                for (let i = 0; i < n; i++) {
                    if (arch.columns[colIdxs[i]].isFloat64) {
                        hasF64 = true;
                        break;
                    }
                }
                if (!hasF64 && n === 1) {
                    const d0 = asObjectColumn(arch.columns[colIdxs[0]]).rawData();
                    if (!needAlive) {
                        for (let row = 0; row < count; row++)
                            cb(d0[row], ents[row]);
                    }
                    else {
                        for (let row = 0; row < count; row++) {
                            const e = ents[row];
                            if (genState.gens[(e >>> GEN_BITS) & INDEX_MASK] === (e & GEN_MASK))
                                cb(d0[row], e);
                        }
                    }
                }
                else if (!hasF64 && n === 2) {
                    const d0 = asObjectColumn(arch.columns[colIdxs[0]]).rawData();
                    const d1 = asObjectColumn(arch.columns[colIdxs[1]]).rawData();
                    if (!needAlive) {
                        for (let row = 0; row < count; row++)
                            cb(d0[row], d1[row], ents[row]);
                    }
                    else {
                        for (let row = 0; row < count; row++) {
                            const e = ents[row];
                            if (genState.gens[(e >>> GEN_BITS) & INDEX_MASK] === (e & GEN_MASK))
                                cb(d0[row], d1[row], e);
                        }
                    }
                }
                else if (!hasF64 && n === 3) {
                    const d0 = asObjectColumn(arch.columns[colIdxs[0]]).rawData();
                    const d1 = asObjectColumn(arch.columns[colIdxs[1]]).rawData();
                    const d2 = asObjectColumn(arch.columns[colIdxs[2]]).rawData();
                    if (!needAlive) {
                        for (let row = 0; row < count; row++)
                            cb(d0[row], d1[row], d2[row], ents[row]);
                    }
                    else {
                        for (let row = 0; row < count; row++) {
                            const e = ents[row];
                            if (genState.gens[(e >>> GEN_BITS) & INDEX_MASK] === (e & GEN_MASK))
                                cb(d0[row], d1[row], d2[row], e);
                        }
                    }
                }
                else {
                    // Generic: any float64 column or arity > 3 — lazy per-row access
                    const lazyCols = colIdxs.map((ci) => {
                        const col = arch.columns[ci];
                        if (col.isFloat64)
                            return { f64: col, raw: null };
                        return { f64: null, raw: asObjectColumn(col).rawData() };
                    });
                    const a0 = lazyCols[0];
                    const a1 = lazyCols[1];
                    const a2 = lazyCols[2];
                    const v = (c, row) => c.raw !== null ? c.raw[row] : c.f64.get(row);
                    if (!needAlive) {
                        for (let row = 0; row < count; row++) {
                            const e = ents[row];
                            if (n === 1) {
                                cb(v(a0, row), e);
                            }
                            else if (n === 2) {
                                cb(v(a0, row), v(a1, row), e);
                            }
                            else if (n === 3) {
                                cb(v(a0, row), v(a1, row), v(a2, row), e);
                            }
                            else {
                                cb(...lazyCols.map((c) => v(c, row)), e);
                            }
                        }
                    }
                    else {
                        for (let row = 0; row < count; row++) {
                            const e = ents[row];
                            if (genState.gens[(e >>> GEN_BITS) & INDEX_MASK] !== (e & GEN_MASK))
                                continue;
                            if (n === 1) {
                                cb(v(a0, row), e);
                            }
                            else if (n === 2) {
                                cb(v(a0, row), v(a1, row), e);
                            }
                            else if (n === 3) {
                                cb(v(a0, row), v(a1, row), v(a2, row), e);
                            }
                            else {
                                cb(...lazyCols.map((c) => v(c, row)), e);
                            }
                        }
                    }
                }
            }
            /** No-filter batch snapshot + callback. Separate function (same JIT rationale as
             *  runFastRows): the large batch body with row-filtered tick logic degrades
             *  the no-filter snapshot loop's tiering when inlined. */
            function runFastBatch(arch, colIdxs, needAlive, genState, cb) {
                const n = factories.length;
                const ents = arch.entities;
                const count = ents.length;
                // Hoist column refs: raw arrays for ObjectColumn, column for Float64Column
                const rawCols = new Array(n);
                const f64Cols = new Array(n);
                for (let ci = 0; ci < n; ci++) {
                    const col = arch.columns[colIdxs[ci]];
                    if (col.isFloat64) {
                        rawCols[ci] = null;
                        f64Cols[ci] = col;
                    }
                    else {
                        rawCols[ci] = asObjectColumn(col).rawData();
                        f64Cols[ci] = null;
                    }
                }
                const entsSnap = new Array(count);
                const colsSnap = new Array(n);
                for (let ci = 0; ci < n; ci++)
                    colsSnap[ci] = new Array(count);
                let len = 0;
                if (!needAlive) {
                    for (let row = 0; row < count; row++) {
                        entsSnap[len] = ents[row];
                        for (let ci = 0; ci < n; ci++) {
                            const raw = rawCols[ci];
                            colsSnap[ci][len] = raw !== null ? raw[row] : f64Cols[ci].get(row);
                        }
                        len++;
                    }
                }
                else {
                    for (let row = 0; row < count; row++) {
                        const e = ents[row];
                        if (genState.gens[(e >>> GEN_BITS) & INDEX_MASK] !== (e & GEN_MASK))
                            continue;
                        entsSnap[len] = e;
                        for (let ci = 0; ci < n; ci++) {
                            const raw = rawCols[ci];
                            colsSnap[ci][len] = raw !== null ? raw[row] : f64Cols[ci].get(row);
                        }
                        len++;
                    }
                }
                if (len > 0)
                    cb(...colsSnap, entsSnap, len);
            }
            function makeQuery(filters, state) {
                // Separate filters: archetype-level (With/Without) vs row-level (Changed/Added)
                const withFilters = filters.filter((f) => f.kind === "with");
                const withoutFilters = filters.filter((f) => f.kind === "without");
                const changedFilters = filters.filter((f) => f.kind === "changed");
                const addedFilters = filters.filter((f) => f.kind === "added");
                // ── Query 候选缓存（Bevy QueryState 等价）──
                // key = factories + With + Without（Changed/Added 是行级，不影响 archetype 候选）
                const cacheKey = factories.map((f) => f.kind).join(",") +
                    "|w:" + withFilters.map((f) => f.factory.kind).join(",") +
                    "|o:" + withoutFilters.map((f) => f.factory.kind).join(",");
                // 单个新 archetype 是否匹配本查询（Bevy QueryState::new_archetype 等价）
                function matchesArchetype(arch) {
                    const kinds = arch.type;
                    for (const f of factories)
                        if (!kinds.includes(f.kind))
                            return false;
                    for (const f of withFilters)
                        if (!kinds.includes(f.factory.kind))
                            return false;
                    for (const f of withoutFilters)
                        if (kinds.includes(f.factory.kind))
                            return false;
                    return true;
                }
                let cachedCandidates; // undefined=未算
                function getCandidates() {
                    if (cachedCandidates !== undefined)
                        return cachedCandidates;
                    // 小世界快速路径：交集很便宜（≤16 archetype），缓存命中的固定开销
                    // （cacheKey 构建 + Map.get）反而更大——跳过缓存避免负提升。
                    let smallestSize = Infinity;
                    for (const f of factories) {
                        const m = w._componentIndex.get(f.kind);
                        if (!m) {
                            cachedCandidates = null;
                            return null;
                        }
                        if (m.size < smallestSize)
                            smallestSize = m.size;
                    }
                    if (smallestSize <= CACHE_THRESHOLD) {
                        cachedCandidates = computeCandidates(factories, withFilters, withoutFilters);
                        return cachedCandidates;
                    }
                    const curGen = w._archetypeGeneration;
                    const entry = w._queryCache.get(cacheKey);
                    if (entry && entry.gen === curGen) {
                        cachedCandidates = entry.candidates;
                        return cachedCandidates;
                    }
                    if (entry) {
                        // 增量：只扫描 new_since(entry.gen) 的新 archetype（Bevy update_archetypes
                        // `&archetypes[old_generation..]` 模式）——匹配则加入候选，不重算全部。
                        for (let i = entry.gen; i < curGen; i++) {
                            const arch = w._archetypes.get(i);
                            if (arch && matchesArchetype(arch))
                                entry.candidates.add(arch.id);
                        }
                        entry.gen = curGen;
                        cachedCandidates = entry.candidates;
                        return cachedCandidates;
                    }
                    // 首次：全量交集（含组件 kind 未知 → null 不缓存）
                    const r = computeCandidates(factories, withFilters, withoutFilters);
                    if (r !== null)
                        w._queryCache.set(cacheKey, { gen: curGen, candidates: r });
                    cachedCandidates = r;
                    return r;
                }
                return {
                    forEach(callback) {
                        const candidate = getCandidates();
                        if (!candidate || candidate.size === 0)
                            return;
                        const n = factories.length;
                        const needAlive = aliveCheck();
                        const genState = w._genState;
                        const cb = callback;
                        const hasRowFilters = changedFilters.length > 0 || addedFilters.length > 0;
                        // Hoist per-factory archetype maps (stable within the query call)
                        const compIdx = new Array(n);
                        for (let i = 0; i < n; i++) {
                            compIdx[i] = w._componentIndex.get(factories[i].kind);
                        }
                        for (const archId of candidate) {
                            const arch = w._archetypes.get(archId);
                            const count = arch.entities.length;
                            if (count === 0)
                                continue;
                            const ents = arch.entities;
                            // Resolve column indices once per archetype (each archetype visited once)
                            const colIdxs = new Array(n);
                            for (let i = 0; i < n; i++)
                                colIdxs[i] = compIdx[i].get(archId);
                            if (hasRowFilters) {
                                // Resolve filter column indices (may be undefined if archetype lacks component)
                                const changedColIdxs = changedFilters.map((f) => w._componentIndex.get(f.factory.kind)?.get(archId));
                                const addedColIdxs = addedFilters.map((f) => w._componentIndex.get(f.factory.kind)?.get(archId));
                                // Lazy data: pre-get raw arrays for ObjectColumns, reference get() for Float64Columns
                                const lazyCols = colIdxs.map((ci) => {
                                    const col = arch.columns[ci];
                                    if (col.isFloat64)
                                        return { f64: col, raw: null };
                                    return { f64: null, raw: asObjectColumn(col).rawData() };
                                });
                                for (let row = 0; row < count; row++) {
                                    const e = ents[row];
                                    if (needAlive && !isAliveFast(e, genState))
                                        continue;
                                    // Changed: ANY specified component changed (OR)
                                    // 按 kind 精确判断（consumption lastSeen）——不做 master 标量快路径：
                                    // master = 全组件 max tick，被任一 Changed 查询消费后会使同 observer
                                    // 的其他 Changed 查询（不同 kind）被错误跳过（P2-03 修复）。
                                    if (changedFilters.length > 0) {
                                        let anyChanged = false;
                                        for (let fi = 0; fi < changedFilters.length; fi++) {
                                            const ci = changedColIdxs[fi];
                                            if (ci === undefined)
                                                continue;
                                            const tick = arch.changedTicks[ci][row];
                                            const kind = changedFilters[fi].factory.kind;
                                            const lastSeen = state ? state.readChanged(e, kind) : w._getLastSeenChanged(e, kind);
                                            if (tick > lastSeen) {
                                                anyChanged = true;
                                                if (state)
                                                    state.writeChanged(e, kind, tick);
                                                else
                                                    w._setLastSeenChanged(e, kind, tick);
                                            }
                                        }
                                        if (!anyChanged)
                                            continue;
                                    }
                                    // Added: ANY specified must have been added (OR)
                                    if (addedFilters.length > 0) {
                                        let anyAdded = false;
                                        for (let fi = 0; fi < addedFilters.length; fi++) {
                                            const ci = addedColIdxs[fi];
                                            if (ci === undefined)
                                                continue;
                                            const tick = arch.addedTicks[ci][row];
                                            const kind = addedFilters[fi].factory.kind;
                                            const lastSeen = state ? state.readAdded(e, kind) : w._getLastSeenAdded(e, kind);
                                            if (tick > lastSeen) {
                                                anyAdded = true;
                                                if (state)
                                                    state.writeAdded(e, kind, tick);
                                                else
                                                    w._setLastSeenAdded(e, kind, tick);
                                            }
                                        }
                                        if (!anyAdded)
                                            continue;
                                    }
                                    // All filters passed: access data lazily (only for this row)
                                    if (n === 1) {
                                        cb(lazyCols[0].raw ? lazyCols[0].raw[row] : lazyCols[0].f64.get(row), e);
                                    }
                                    else if (n === 2) {
                                        cb(lazyCols[0].raw ? lazyCols[0].raw[row] : lazyCols[0].f64.get(row), lazyCols[1].raw ? lazyCols[1].raw[row] : lazyCols[1].f64.get(row), e);
                                    }
                                    else if (n === 3) {
                                        cb(lazyCols[0].raw ? lazyCols[0].raw[row] : lazyCols[0].f64.get(row), lazyCols[1].raw ? lazyCols[1].raw[row] : lazyCols[1].f64.get(row), lazyCols[2].raw ? lazyCols[2].raw[row] : lazyCols[2].f64.get(row), e);
                                    }
                                    else {
                                        cb(...lazyCols.map((c) => (c.raw ? c.raw[row] : c.f64.get(row))), e);
                                    }
                                }
                                continue;
                            }
                            // ── No row filters: delegate to the specialized fast path ──
                            runFastRows(arch, colIdxs, needAlive, genState, cb);
                        }
                    },
                    batch(callback) {
                        const candidate = getCandidates();
                        if (!candidate || candidate.size === 0)
                            return;
                        const n = factories.length;
                        const needAlive = aliveCheck();
                        const genState = w._genState;
                        const hasRowFilters = changedFilters.length > 0 || addedFilters.length > 0;
                        const compIdx = new Array(n);
                        for (let i = 0; i < n; i++) {
                            compIdx[i] = w._componentIndex.get(factories[i].kind);
                        }
                        for (const archId of candidate) {
                            const arch = w._archetypes.get(archId);
                            const count = arch.entities.length;
                            if (count === 0)
                                continue;
                            const ents = arch.entities;
                            const colIdxs = new Array(n);
                            for (let i = 0; i < n; i++)
                                colIdxs[i] = compIdx[i].get(archId);
                            if (hasRowFilters) {
                                const changedColIdxs = changedFilters.map((f) => w._componentIndex.get(f.factory.kind)?.get(archId));
                                const addedColIdxs = addedFilters.map((f) => w._componentIndex.get(f.factory.kind)?.get(archId));
                                // Build filtered snapshot arrays (preallocated)
                                const aliveEnts = new Array(count);
                                const aliveCols = new Array(n);
                                for (let ci = 0; ci < n; ci++)
                                    aliveCols[ci] = new Array(count);
                                const rawCols = new Array(n);
                                const f64Cols = new Array(n);
                                for (let ci = 0; ci < n; ci++) {
                                    const col = arch.columns[colIdxs[ci]];
                                    if (col.isFloat64) {
                                        rawCols[ci] = null;
                                        f64Cols[ci] = col;
                                    }
                                    else {
                                        rawCols[ci] = asObjectColumn(col).rawData();
                                        f64Cols[ci] = null;
                                    }
                                }
                                let len = 0;
                                for (let row = 0; row < count; row++) {
                                    const e = ents[row];
                                    if (needAlive && !isAliveFast(e, genState))
                                        continue;
                                    // Changed check (OR)
                                    if (changedFilters.length > 0) {
                                        let anyChanged = false;
                                        for (let fi = 0; fi < changedFilters.length; fi++) {
                                            const ci = changedColIdxs[fi];
                                            if (ci === undefined)
                                                continue;
                                            const tick = arch.changedTicks[ci][row];
                                            const kind = changedFilters[fi].factory.kind;
                                            const lastSeen = state ? state.readChanged(e, kind) : w._getLastSeenChanged(e, kind);
                                            if (tick > lastSeen) {
                                                anyChanged = true;
                                                if (state)
                                                    state.writeChanged(e, kind, tick);
                                                else
                                                    w._setLastSeenChanged(e, kind, tick);
                                            }
                                        }
                                        if (!anyChanged)
                                            continue;
                                    }
                                    // Added check (OR)
                                    if (addedFilters.length > 0) {
                                        let anyAdded = false;
                                        for (let fi = 0; fi < addedFilters.length; fi++) {
                                            const ci = addedColIdxs[fi];
                                            if (ci === undefined)
                                                continue;
                                            const tick = arch.addedTicks[ci][row];
                                            const kind = addedFilters[fi].factory.kind;
                                            const lastSeen = state ? state.readAdded(e, kind) : w._getLastSeenAdded(e, kind);
                                            if (tick > lastSeen) {
                                                anyAdded = true;
                                                if (state)
                                                    state.writeAdded(e, kind, tick);
                                                else
                                                    w._setLastSeenAdded(e, kind, tick);
                                            }
                                        }
                                        if (!anyAdded)
                                            continue;
                                    }
                                    aliveEnts[len] = e;
                                    for (let ci = 0; ci < n; ci++) {
                                        const raw = rawCols[ci];
                                        aliveCols[ci][len] = raw !== null ? raw[row] : f64Cols[ci].get(row);
                                    }
                                    len++;
                                }
                                if (len > 0)
                                    callback(...aliveCols, aliveEnts, len);
                                continue;
                            }
                            // ── No row filters: snapshot matching rows before invoking the callback.
                            //    The callback may mutate the queried archetype (e.g. add a component to
                            //    a matched entity → it moves to another archetype and swap-removes rows
                            //    from the live arrays). Iterating live arrays under mutation yields
                            //    undefined rows (regression: GeometrySystem specSig crash). ──
                            runFastBatch(arch, colIdxs, needAlive, genState, callback);
                        }
                    },
                    entities() {
                        const candidate = getCandidates();
                        if (!candidate || candidate.size === 0)
                            return [];
                        const needAlive = aliveCheck();
                        const genState = w._genState;
                        const hasRowFilters = changedFilters.length > 0 || addedFilters.length > 0;
                        const result = [];
                        for (const archId of candidate) {
                            const arch = w._archetypes.get(archId);
                            const count = arch.entities.length;
                            if (hasRowFilters) {
                                const changedColIdxs = changedFilters.map((f) => w._componentIndex.get(f.factory.kind)?.get(archId));
                                const addedColIdxs = addedFilters.map((f) => w._componentIndex.get(f.factory.kind)?.get(archId));
                                for (let row = 0; row < count; row++) {
                                    const e = arch.entities[row];
                                    if (needAlive && !isAliveFast(e, genState))
                                        continue;
                                    if (changedFilters.length > 0) {
                                        let anyChanged = false;
                                        for (let fi = 0; fi < changedFilters.length; fi++) {
                                            const ci = changedColIdxs[fi];
                                            if (ci === undefined)
                                                continue;
                                            const tick = arch.changedTicks[ci][row];
                                            const kind = changedFilters[fi].factory.kind;
                                            const lastSeen = state ? state.readChanged(e, kind) : w._getLastSeenChanged(e, kind);
                                            if (tick > lastSeen) {
                                                anyChanged = true;
                                                if (state)
                                                    state.writeChanged(e, kind, tick);
                                                else
                                                    w._setLastSeenChanged(e, kind, tick);
                                            }
                                        }
                                        if (!anyChanged)
                                            continue;
                                    }
                                    if (addedFilters.length > 0) {
                                        let anyAdded = false;
                                        for (let fi = 0; fi < addedFilters.length; fi++) {
                                            const ci = addedColIdxs[fi];
                                            if (ci === undefined)
                                                continue;
                                            const tick = arch.addedTicks[ci][row];
                                            const kind = addedFilters[fi].factory.kind;
                                            const lastSeen = state ? state.readAdded(e, kind) : w._getLastSeenAdded(e, kind);
                                            if (tick > lastSeen) {
                                                anyAdded = true;
                                                if (state)
                                                    state.writeAdded(e, kind, tick);
                                                else
                                                    w._setLastSeenAdded(e, kind, tick);
                                            }
                                        }
                                        if (!anyAdded)
                                            continue;
                                    }
                                    result.push(e);
                                }
                            }
                            else {
                                if (!needAlive) {
                                    for (let row = 0; row < count; row++)
                                        result.push(arch.entities[row]);
                                }
                                else {
                                    const ents = arch.entities;
                                    for (let row = 0; row < count; row++) {
                                        const e = ents[row];
                                        if (genState.gens[(e >>> GEN_BITS) & INDEX_MASK] === (e & GEN_MASK))
                                            result.push(e);
                                    }
                                }
                            }
                        }
                        return result;
                    },
                    first() {
                        const candidate = getCandidates();
                        if (!candidate || candidate.size === 0)
                            return undefined;
                        const needAlive = aliveCheck();
                        const genState = w._genState;
                        const hasRowFilters = changedFilters.length > 0 || addedFilters.length > 0;
                        for (const archId of candidate) {
                            const arch = w._archetypes.get(archId);
                            const ents = arch.entities;
                            // 行级过滤器（Changed/Added）——first() 也必须遵守（回归：此前直接返回首个实体）
                            if (hasRowFilters) {
                                const changedColIdxs = changedFilters.map((f) => w._componentIndex.get(f.factory.kind)?.get(archId));
                                const addedColIdxs = addedFilters.map((f) => w._componentIndex.get(f.factory.kind)?.get(archId));
                                for (let row = 0; row < ents.length; row++) {
                                    const e = ents[row];
                                    if (needAlive && !isAliveFast(e, genState))
                                        continue;
                                    // OR 语义与 forEach/entities 一致：任一 Changed 命中 + 任一 Added 命中
                                    let anyChanged = true;
                                    if (changedFilters.length > 0) {
                                        anyChanged = false;
                                        for (let fi = 0; fi < changedFilters.length; fi++) {
                                            const ci = changedColIdxs[fi];
                                            if (ci === undefined)
                                                continue;
                                            const tick = arch.changedTicks[ci][row];
                                            const kind = changedFilters[fi].factory.kind;
                                            const lastSeen = state ? state.readChanged(e, kind) : w._getLastSeenChanged(e, kind);
                                            if (tick > lastSeen) {
                                                anyChanged = true;
                                                if (state)
                                                    state.writeChanged(e, kind, tick);
                                                else
                                                    w._setLastSeenChanged(e, kind, tick);
                                            }
                                        }
                                    }
                                    if (!anyChanged)
                                        continue;
                                    let anyAdded = true;
                                    if (addedFilters.length > 0) {
                                        anyAdded = false;
                                        for (let fi = 0; fi < addedFilters.length; fi++) {
                                            const ci = addedColIdxs[fi];
                                            if (ci === undefined)
                                                continue;
                                            const tick = arch.addedTicks[ci][row];
                                            const kind = addedFilters[fi].factory.kind;
                                            const lastSeen = state ? state.readAdded(e, kind) : w._getLastSeenAdded(e, kind);
                                            if (tick > lastSeen) {
                                                anyAdded = true;
                                                if (state)
                                                    state.writeAdded(e, kind, tick);
                                                else
                                                    w._setLastSeenAdded(e, kind, tick);
                                            }
                                        }
                                    }
                                    if (anyAdded)
                                        return e;
                                }
                                continue;
                            }
                            if (!needAlive) {
                                if (ents.length > 0)
                                    return ents[0];
                            }
                            else {
                                for (let row = 0; row < ents.length; row++) {
                                    const e = ents[row];
                                    if (genState.gens[(e >>> GEN_BITS) & INDEX_MASK] === (e & GEN_MASK))
                                        return e;
                                }
                            }
                        }
                        return undefined;
                    },
                    filter(...more) {
                        return makeQuery([...filters, ...more], state);
                    },
                    withState(nextState) {
                        return makeQuery(filters, nextState);
                    },
                };
            }
            return makeQuery([]);
        };
        this.query = queryFn;
        /** Mutation-safe query builder: forEach snapshots the complete result set
         * before callbacks run, and filter()/withState() preserve that mode. */
        this.queryMut = (...factories) => {
            const wrap = (source) => {
                const runBatch = source.batch;
                return {
                    ...source,
                    forEach(callback) {
                        const visit = callback;
                        const snapshot = [];
                        runBatch((...args) => {
                            const count = args.pop();
                            const entities = args.pop();
                            const columns = args;
                            for (let i = 0; i < count; i++) {
                                snapshot.push({
                                    data: columns.map((column) => column[i]),
                                    entity: entities[i],
                                });
                            }
                        });
                        for (const { data, entity } of snapshot) {
                            if (!w.isAlive(entity))
                                continue;
                            visit(...data, entity);
                        }
                    },
                    batch(callback) {
                        const chunks = [];
                        runBatch((...args) => {
                            chunks.push(args);
                        });
                        const visit = callback;
                        for (const args of chunks)
                            visit(...args);
                    },
                    filter(...more) {
                        return wrap(source.filter(...more));
                    },
                    withState(nextState) {
                        return wrap(source.withState(nextState));
                    },
                };
            };
            return wrap(queryFn.call(w, ...factories));
        };
        // ── Removed component buffer（Bevy RemovedComponents：双缓冲 2 帧窗口 + per-observer 游标）──
        // 与 drainKilled() 同一套语义：帧内排序无关。排在移除者之后的系统本帧看到；
        // 排在前面的系统下帧仍能看到（旧实现在帧**开始**清空缓冲，后者永远漏看）。
        this.removed = (factory) => {
            const cid = _kindIds.get(factory.kind);
            if (cid === undefined)
                return [];
            const state = w._removedState;
            const prev = state.prev[cid];
            const cur = state.buffer[cid];
            const prevLen = prev?.length ?? 0;
            const total = prevLen + (cur?.length ?? 0);
            if (total === 0)
                return [];
            const observer = w._currentObserver ?? "__global__";
            let cursors = state.cursors.get(observer);
            if (!cursors) {
                cursors = new Map();
                state.cursors.set(observer, cursors);
            }
            const cursor = cursors.get(cid) ?? 0;
            if (cursor >= total)
                return [];
            const result = cursor < prevLen
                ? [...prev.slice(cursor), ...cur]
                : cur.slice(cursor - prevLen);
            cursors.set(cid, total);
            return result;
        };
    }
    // ══════════════════════════════════════════════════
    //  Public API — Sync
    // ══════════════════════════════════════════════════
    /**
     * 帧末轮转移除事件双缓冲（Bevy RemovedComponents 事件存活 2 帧）。
     *
     * 与 `drainKilled()` 同一套语义：**帧内排序无关**——排在移除者之后的系统本帧看到，
     * 排在前面的系统下帧仍能看到。每 kind 独立平移游标：
     * `new = clamp(old − 被淘汰帧长, 0, 新窗口长)`。数组换位复用（零分配）。
     */
    _rotateRemoved() {
        const state = this._removedState;
        const kinds = state.buffer.length;
        if (kinds === 0)
            return;
        for (let cid = 0; cid < kinds; cid++) {
            const cur = state.buffer[cid];
            const retired = state.prev[cid];
            const retiredLen = retired?.length ?? 0;
            const curLen = cur?.length ?? 0;
            if (retiredLen === 0 && curLen === 0)
                continue;
            const curArr = cur ?? [];
            const retiredArr = retired ?? [];
            retiredArr.length = 0; // 被淘汰的数组复用为下一帧的 buffer
            state.prev[cid] = curArr;
            state.buffer[cid] = retiredArr;
            state.seen[cid]?.clear();
            if (state.cursors.size === 0)
                continue;
            for (const cursors of state.cursors.values()) {
                const cursor = cursors.get(cid) ?? 0;
                if (cursor === 0)
                    continue;
                const shifted = cursor - retiredLen;
                cursors.set(cid, shifted < 0 ? 0 : shifted > curLen ? curLen : shifted);
            }
        }
    }
    /** @internal Enqueue a deferred command closure. Used by Commands class. */
    _enqueue(fn) {
        this._commands.push(fn);
    }
    /** Apply all pending commands (structural mutations). No-op when there are no
     *  deferred commands — the engine calls this after each system for safety. */
    applyCommands() {
        if (this._commands.length === 0)
            return;
        for (const cmd of this._commands)
            cmd();
        this._commands.length = 0;
    }
    flushDestroyed() {
        if (this._deferredDestroys.length > 0)
            this._structuralDirtyTick = this._tick + 1;
        this._flushDestroys();
    }
    get hasKilledEntities() {
        return this._killedThisFrame.length > 0;
    }
    /** Highest tick at which component `kind` was changed. For dirty-check fast path. */
    lastChangedTick(kind) {
        return this._lastChangedTick.get(kind) ?? 0;
    }
    /**
     * Killed entities unseen by THIS observer (system). Bevy RemovedComponents 等价——
     * 多读者：每个 observer 独立游标，都看到全部未消费 kill（不再单消费者）。
     * 双缓冲：kill 事件保留 2 帧（与 Bevy 事件双缓冲一致），因此系统与 killer 的
     * 帧内先后顺序不影响可见性；帧末 setCurrentObserver(null) 轮转缓冲区。
     */
    drainKilled() {
        const observer = this._currentObserver ?? "__global__";
        const cursor = this._killedCursor.get(observer) ?? 0;
        const prevCount = this._killedPrevFrame.length;
        const total = prevCount + this._killedThisFrame.length;
        if (cursor >= total)
            return [];
        const result = cursor < prevCount
            ? [...this._killedPrevFrame.slice(cursor), ...this._killedThisFrame]
            : this._killedThisFrame.slice(cursor - prevCount);
        this._killedCursor.set(observer, total);
        return result;
    }
    // ══════════════════════════════════════════════════
    //  Public API — Engine interface
    // ══════════════════════════════════════════════════
    get tick() {
        return this._tick;
    }
    setCurrentObserver(name) {
        if (name === null) {
            // 帧边界：轮转双缓冲（prev ← thisFrame，thisFrame ← []）并把各 observer 游标
            // 平移到新逻辑流坐标（减去被淘汰的前帧长度）。未消费的 kill 会留在 prev，
            // 下帧对任何 observer 仍可见——帧内排序无关（Bevy RemovedComponents 语义）。
            const retired = this._killedPrevFrame.length;
            this._killedPrevFrame = this._killedThisFrame;
            this._killedThisFrame = [];
            if (retired > 0) {
                const total = this._killedPrevFrame.length;
                for (const [observer, cursor] of this._killedCursor) {
                    const shifted = cursor - retired;
                    this._killedCursor.set(observer, shifted < 0 ? 0 : shifted > total ? total : shifted);
                }
            }
            // 组件移除事件与实体消亡同帧边界轮转（同一套 2 帧窗口语义）。
            this._rotateRemoved();
        }
        this._currentObserver = name;
    }
    isAnyDirty(kinds, sinceTick) {
        if (this._structuralDirtyTick > sinceTick)
            return true;
        for (let i = 0; i < kinds.length; i++) {
            const lastChanged = this._lastChangedTick.get(kinds[i]);
            if (lastChanged !== undefined && lastChanged > sinceTick)
                return true;
        }
        return false;
    }
    dumpEcs() {
        const eMap = new Map();
        for (const [_archId, arch] of this._archetypes) {
            for (let row = 0; row < arch.entities.length; row++) {
                const e = arch.entities[row];
                let item = eMap.get(e);
                if (!item) {
                    item = { comps: new Set(), data: {}, kinds: new Set() };
                    eMap.set(e, item);
                }
                for (let ci = 0; ci < arch.type.length; ci++) {
                    const kind = arch.type[ci];
                    item.comps.add(kind);
                    item.data[kind] = arch.columns[ci].get(row);
                }
                // Archetype kinds
                for (const k of arch.type)
                    item.kinds.add(k);
            }
        }
        const entities = [...eMap.entries()]
            .sort(([a], [b]) => a - b)
            .map(([eid, entry]) => ({
            eid,
            archetype: [...entry.kinds].sort(),
            components: [...entry.comps].sort(),
            data: entry.data,
        }));
        return { entityCount: this.entityCount(), entities };
    }
    // ═══════════════════════════════════════════════════════════
    //  Debug / tooling
    // ═══════════════════════════════════════════════════════════
    /** Registered component kinds (insertion order) — entity introspection (Bevy archetype/components 等价). */
    kinds() {
        return _kindOrder.slice();
    }
    /** Raw component data for an entity+kind (shallow copy — value-type introspection). */
    componentData(entity, kind) {
        const data = this._getComponentRaw(entity, kind);
        return data ? { ...data } : undefined;
    }
    // ═══════════════════════════════════════════════════════════
    //  Private — archetype management
    // ═══════════════════════════════════════════════════════════
    _nextTick() {
        return ++this._tick;
    }
    /** Find or create an archetype for a sorted set of component kinds.
     *  Phase 2: kinds with a registered schema get Float64Column, others ObjectColumn. */
    _findOrCreateArchetype(kinds) {
        const key = _typeKey(kinds);
        let archId = this._archetypeIndex.get(key);
        if (archId !== undefined)
            return this._archetypes.get(archId);
        archId = this._nextArchetypeId++;
        const columns = kinds.map((k) => {
            const schema = _schemas.get(k);
            return schema ? new Float64Column(schema) : new ObjectColumn();
        });
        const arch = {
            id: archId,
            type: kinds,
            columns,
            entities: [],
            addedTicks: [],
            changedTicks: [],
        };
        // Initialize tick arrays per column
        for (let ci = 0; ci < kinds.length; ci++) {
            arch.addedTicks.push([]);
            arch.changedTicks.push([]);
        }
        this._archetypes.set(archId, arch);
        this._archetypeIndex.set(key, archId);
        this._archetypeGeneration++; // 结构变化 → 失效 query 缓存
        // Register in component index
        for (let ci = 0; ci < kinds.length; ci++) {
            let compMap = this._componentIndex.get(kinds[ci]);
            if (!compMap) {
                compMap = new Map();
                this._componentIndex.set(kinds[ci], compMap);
            }
            compMap.set(archId, ci);
        }
        return arch;
    }
    /** @internal Get raw component data (no isAlive check, no type safety). Used by Commands. */
    _getComponentRaw(entity, kind) {
        // Bevy deferred despawn 语义：destroy→flush 窗口内组件仍可读
        // （on_remove 钩子回调需要读取其他组件；flush 后 _entityIndex 删除 → undefined）
        const rec = this._entityIndex.get(entity);
        if (!rec)
            return undefined;
        const compMap = this._componentIndex.get(kind);
        if (!compMap)
            return undefined;
        const colIdx = compMap.get(rec.archetypeId);
        if (colIdx === undefined)
            return undefined;
        const arch = this._archetypes.get(rec.archetypeId);
        return arch.columns[colIdx].get(rec.row);
    }
    _getComponentEntryRaw(entity, kind) {
        const rec = this._entityIndex.get(entity);
        if (!rec)
            return undefined;
        const compMap = this._componentIndex.get(kind);
        if (!compMap)
            return undefined;
        const colIdx = compMap.get(rec.archetypeId);
        if (colIdx === undefined)
            return undefined;
        const arch = this._archetypes.get(rec.archetypeId);
        return {
            data: arch.columns[colIdx].get(rec.row),
            addedTick: arch.addedTicks[colIdx][rec.row],
            changedTick: arch.changedTicks[colIdx][rec.row],
        };
    }
    /** O(1) — checks component_index for the archetype. */
    _hasComponentInternal(entity, kind) {
        // 同 _getComponentRaw：destroy→flush 窗口内可读（on_remove 钩子语义）
        const rec = this._entityIndex.get(entity);
        if (!rec)
            return false;
        return this._componentIndex.get(kind)?.has(rec.archetypeId) ?? false;
    }
    // ═══════════════════════════════════════════════════════════
    //  Private — component write/delete (now archetype-based)
    // ═══════════════════════════════════════════════════════════
    /** Write a component to an entity — handles both insert (new kind) and update (existing kind). */
    _writeComponent(entity, component) {
        const kind = component.type;
        const tick = this._nextTick();
        const { type: _type, ...data } = component;
        const rec = this._entityIndex.get(entity);
        if (!rec) {
            // Entity has no components yet — create singleton archetype
            const arch = this._findOrCreateArchetype([kind]);
            arch.columns[0].push(data);
            arch.entities.push(entity);
            arch.addedTicks[0].push(tick);
            arch.changedTicks[0].push(tick);
            this._entityIndex.set(entity, { archetypeId: arch.id, row: arch.entities.length - 1 });
            this._lastChangedTick.set(kind, tick);
            const addHooks = this._onAddHooks.get(kind);
            if (addHooks?.size)
                this._fireHooks(addHooks, entity);
            if (this.hasChangedHooks) {
                const hooks = this.changedHooks.get(kind);
                if (hooks?.size)
                    this._fireHooks(hooks, entity, data);
            }
            return;
        }
        const oldArch = this._archetypes.get(rec.archetypeId);
        const compMap = this._componentIndex.get(kind);
        const existingColIdx = compMap?.get(oldArch.id);
        if (existingColIdx !== undefined) {
            // Update — component kind already present
            oldArch.columns[existingColIdx].set(rec.row, data);
            oldArch.changedTicks[existingColIdx][rec.row] = tick;
            this._lastChangedTick.set(kind, tick);
            if (this.hasChangedHooks) {
                const hooks = this.changedHooks.get(kind);
                if (hooks?.size)
                    this._fireHooks(hooks, entity, data);
            }
            return;
        }
        // Insert new kind — entity moves to a new archetype
        const newKinds = [...oldArch.type, kind].sort();
        const newArch = this._findOrCreateArchetype(newKinds);
        const newRow = newArch.entities.length;
        // Copy data from old archetype
        for (let nci = 0; nci < newKinds.length; nci++) {
            const nk = newKinds[nci];
            if (nk === kind) {
                // New component — push fresh data
                newArch.columns[nci].push(data);
                newArch.addedTicks[nci].push(tick);
                newArch.changedTicks[nci].push(tick);
            }
            else {
                // Copy from old archetype
                const oci = this._componentIndex.get(nk).get(oldArch.id);
                newArch.columns[nci].push(oldArch.columns[oci].get(rec.row));
                newArch.addedTicks[nci].push(oldArch.addedTicks[oci][rec.row]);
                newArch.changedTicks[nci].push(oldArch.changedTicks[oci][rec.row]);
            }
        }
        newArch.entities.push(entity);
        // Remove from old archetype (swap-and-pop all columns)
        this._removeEntityFromArchetype(entity, rec, oldArch);
        this._entityIndex.set(entity, { archetypeId: newArch.id, row: newRow });
        this._lastChangedTick.set(kind, tick);
        // Fire on_add hooks (Bevy: first time this kind is added to this entity)
        const addHooks = this._onAddHooks.get(kind);
        if (addHooks?.size)
            this._fireHooks(addHooks, entity);
        if (this.hasChangedHooks) {
            const hooks = this.changedHooks.get(kind);
            if (hooks?.size)
                this._fireHooks(hooks, entity, data);
        }
    }
    /** Remove a component kind from an entity — moves to new archetype without that kind. */
    _deleteComponent(entity, kind) {
        const rec = this._entityIndex.get(entity);
        if (!rec)
            return;
        const oldArch = this._archetypes.get(rec.archetypeId);
        const colIdx = this._componentIndex.get(kind)?.get(oldArch.id);
        if (colIdx === undefined)
            return; // entity doesn't have this kind
        // Fire on_remove hooks only when this entity actually has the component.
        // Hooks receive the data that is about to be removed and are isolated from
        // each other; removal itself always completes.
        const removeHooks = this._onRemoveHooks.get(kind);
        if (removeHooks?.size) {
            const guard = `${entity}\0${kind}`;
            if (this._removingComponents.has(guard))
                return;
            this._removingComponents.add(guard);
            try {
                this._fireHooks(removeHooks, entity, oldArch.columns[colIdx].get(rec.row));
            }
            finally {
                this._removingComponents.delete(guard);
            }
        }
        const tick = this._nextTick();
        this.trackRemoval(entity, kind, tick);
        const newKinds = oldArch.type.filter((k) => k !== kind);
        if (newKinds.length === 0) {
            // Entity will have no components — destroy it from archetype, keep entity slot
            this._removeEntityFromArchetype(entity, rec, oldArch);
            this._entityIndex.delete(entity);
            return;
        }
        const newArch = this._findOrCreateArchetype(newKinds);
        const newRow = newArch.entities.length;
        for (let nci = 0; nci < newKinds.length; nci++) {
            const nk = newKinds[nci];
            const oci = this._componentIndex.get(nk).get(oldArch.id);
            newArch.columns[nci].push(oldArch.columns[oci].get(rec.row));
            newArch.addedTicks[nci].push(oldArch.addedTicks[oci][rec.row]);
            newArch.changedTicks[nci].push(oldArch.changedTicks[oci][rec.row]);
        }
        newArch.entities.push(entity);
        // Remove from old archetype
        this._removeEntityFromArchetype(entity, rec, oldArch);
        this._entityIndex.set(entity, { archetypeId: newArch.id, row: newRow });
    }
    /** Swap-and-pop entity from its archetype. Updates moved entity's row. */
    _removeEntityFromArchetype(entity, rec, arch) {
        void entity;
        const oldLast = arch.entities.length - 1;
        if (rec.row !== oldLast) {
            const movedEntity = arch.entities[oldLast];
            // Copy last row data over removed row, then pop
            for (let ci = 0; ci < arch.type.length; ci++) {
                arch.columns[ci].set(rec.row, arch.columns[ci].get(oldLast));
                arch.columns[ci].pop();
                arch.addedTicks[ci][rec.row] = arch.addedTicks[ci][oldLast];
                arch.addedTicks[ci].pop();
                arch.changedTicks[ci][rec.row] = arch.changedTicks[ci][oldLast];
                arch.changedTicks[ci].pop();
            }
            arch.entities[rec.row] = movedEntity;
            arch.entities.pop();
            this._entityIndex.set(movedEntity, { archetypeId: arch.id, row: rec.row });
        }
        else {
            for (let ci = 0; ci < arch.type.length; ci++) {
                arch.columns[ci].swapRemove(rec.row);
                arch.addedTicks[ci].pop();
                arch.changedTicks[ci].pop();
            }
            arch.entities.pop();
        }
    }
    /** Batch cleanup of deferred destroys. */
    _flushDestroys() {
        if (this._deferredDestroys.length === 0)
            return;
        for (const entity of this._deferredDestroys)
            this._killedThisFrame.push(entity);
        for (const entity of this._deferredDestroys) {
            const rec = this._entityIndex.get(entity);
            if (rec) {
                const arch = this._archetypes.get(rec.archetypeId);
                // Fire on_remove for each component kind before destroying (Bevy: Despawn)。
                // 回调传入组件数据——实体已标记销毁，isAlive 为 false，getComponent 读不到，
                // 而 Bevy 语义是 on_remove 回调可读即将移除的组件。
                for (const kind of arch.type) {
                    const hooks = this._onRemoveHooks.get(kind);
                    if (hooks && hooks.size > 0) {
                        const colIdx = this._componentIndex.get(kind)?.get(arch.id);
                        const data = colIdx !== undefined ? arch.columns[colIdx].get(rec.row) : undefined;
                        this._fireHooks(hooks, entity, data);
                    }
                }
                this._removeEntityFromArchetype(entity, rec, arch);
                this._entityIndex.delete(entity);
            }
        }
        // Clean up observer tick tracking for destroyed entities
        for (const entity of this._deferredDestroys) {
            for (const obsMap of this._seenAdded.values())
                obsMap.delete(entity);
            for (const obsMap of this._seenChanged.values())
                obsMap.delete(entity);
        }
        this._deferredDestroys.length = 0;
    }
    /** Record one same-frame removal per entity/kind and advance the dirty tick. */
    trackRemoval(entity, kind, tick) {
        const cid = _kindIds.get(kind);
        if (cid === undefined)
            return;
        let seen = this._removedState.seen[cid];
        if (!seen) {
            seen = new Set();
            this._removedState.seen[cid] = seen;
        }
        let entries = this._removedState.buffer[cid];
        if (!entries) {
            entries = [];
            this._removedState.buffer[cid] = entries;
        }
        if (!seen.has(entity)) {
            seen.add(entity);
            entries.push(entity);
        }
        // 移除也算该 kind 的变更——bump lastChangedTick 让 dirty-check fast path
        // 感知（Bevy change detection：RemovedComponents 独立 reader 可见移除）。
        this._lastChangedTick.set(kind, tick);
    }
    /** Fire all hooks in a set for an entity. No-op if hooks is undefined/empty. */
    _fireHooks(hooks, entity, data) {
        if (!hooks || hooks.size === 0)
            return;
        const callbacks = Array.from(hooks);
        for (const cb of callbacks) {
            try {
                cb(entity, data);
            }
            catch (error) {
                console.error("[ecs] lifecycle hook failed:", error);
            }
        }
    }
    // ── Observer tick tracking ──
    _getLastSeenAdded(entity, kind) {
        return (this._seenAdded
            .get(this._currentObserver ?? "__")
            ?.get(entity)
            ?.get(kind) ?? 0);
    }
    _getLastSeenChanged(entity, kind) {
        return (this._seenChanged
            .get(this._currentObserver ?? "__")
            ?.get(entity)
            ?.get(kind) ?? 0);
    }
    _setLastSeenAdded(entity, kind, tick) {
        const key = this._currentObserver ?? "__";
        let obs = this._seenAdded.get(key);
        if (!obs) {
            obs = new Map();
            this._seenAdded.set(key, obs);
        }
        let ent = obs.get(entity);
        if (!ent) {
            ent = new Map();
            obs.set(entity, ent);
        }
        ent.set(kind, tick);
    }
    _setLastSeenChanged(entity, kind, tick) {
        const key = this._currentObserver ?? "__";
        let obs = this._seenChanged.get(key);
        if (!obs) {
            obs = new Map();
            this._seenChanged.set(key, obs);
        }
        let ent = obs.get(entity);
        if (!ent) {
            ent = new Map();
            obs.set(entity, ent);
        }
        ent.set(kind, tick);
    }
}
//# sourceMappingURL=world.js.map