// packages/ecs/src/world.ts — World class
// Central ECS data store: entity CRUD, component pools, query, archetypes.
import type { Entity } from "./entity";
import {
  entityIndex,
  entityGen,
  packEntity,
  getGenerations,
  resizeGenerations,
  _freeSlots,
  _entityState,
  GEN_BITS,
  GEN_MASK,
  INDEX_MASK,
} from "./entity";
import { _defaults, _kindOrder, _kindIds, _kindBits, _schemas, _sparseKinds } from "./component";
import type { ComponentFactory, ResourceFactory, DataOf } from "./component";
import type { Component } from "./component";
import { ObjectColumn, Float64Column } from "./storage";
import type { Column } from "./storage";
import type { Archetype } from "./archetype";
import type { Query, QueryFilter } from "./query";

// ═══════════════════════════════════════════════════════════
// World
// ═══════════════════════════════════════════════════════════

/** Build a stable archetype key from sorted kind names. */
function _typeKey(kinds: string[]): string {
  return [...kinds].sort().join("\x00");
}

export class World {
  private _tick = 0;
  private _entityCount = 0;

  // ── Archetype column storage (Mertens Building ECS #1+#2) ──
  private _entityIndex = new Map<Entity, { archetypeId: number; row: number }>();
  private _archetypes = new Map<number, Archetype>();
  private _componentIndex = new Map<string, Map<number, number>>(); // kind → (archetypeId → colIdx)
  private _archetypeIndex = new Map<string, number>(); // typeKey → archetypeId
  private _nextArchetypeId = 0;
  /** Archetype 结构代际——新增 archetype 时 +1，用于 query 候选缓存失效。 */
  private _archetypeGeneration = 0;
  /** Query 候选缓存：key = factories+With+Without → { 代际, 匹配 archetype 集 }。
   *  稳态（无新 archetype）下消除每次 query 的交集重算（Bevy QueryState 等价）。 */
  private _queryCache = new Map<string, { gen: number; candidates: Set<number> }>();

  // ── Deferred command buffer ──
  private _commands: Array<() => void> = [];

  // ── World resources (Bevy-style Res<T>) ──
  /** Resource-kind → singleton entity. ResourceFactory resources are components on dedicated entities. */
  private _resourceEntities = new Map<string, Entity>();

  /** Per-observer per-resource-kind last-seen changedTick. Auto-managed by resourceChanged(). */
  private _seenResourceTicks = new Map<string, Map<string, number>>();

  /** Fallback storage for ComponentFactory-based resources (backward compat). */
  private _resources = new Map<string, unknown>();

  // ── Deferred destroy batching ──
  private _deferredDestroys: Entity[] = [];
  /** Entities killed since last drainKilled() call. Populated by _flushDestroys. */
  private _killedThisFrame: Entity[] = [];

  // ── Before-destroy hooks (Johnson §3.2 p53: "finalizer or destruction callback system") ──
  /** Entities currently being destroyed — prevents re-entrant cascade loops. */
  private _pendingDestroy: Set<Entity> | undefined;
  private _onBeforeDestroyHooks = new Set<(entity: Entity) => void>();

  // ── Component lifecycle hooks (Bevy-aligned: on_add / on_remove per component kind) ──
  /** Per-kind on_add hooks. Fires when a component type is added to an entity for the first time. */
  private _onAddHooks = new Map<string, Set<(entity: Entity) => void>>();
  /** Per-kind on_remove hooks. Fires when a component type is removed from an entity. */
  private _onRemoveHooks = new Map<string, Set<(entity: Entity) => void>>();

  // ── Component removal tracking ──
  /** Per-component-ID entities that had a component removed this frame. Indexed by component ID. */
  private _removedBuffer: Set<Entity>[] = [];

  // ── Observer tracking ──
  private _currentObserver: string | null = null;

  /** Per-kind highest changedTick — enables O(kinds) isAnyDirty (Johnson Ch5.1 cache-friendly). */
  private _lastChangedTick = new Map<string, number>();

  // Per-observer per-entity per-kind last-seen ticks
  private _seenAdded = new Map<string, Map<Entity, Map<string, number>>>();
  private _seenChanged = new Map<string, Map<Entity, Map<string, number>>>();
  private _seenAddedMaster = new Map<string, Map<Entity, number>>();
  private _seenChangedMaster = new Map<string, Map<Entity, number>>();

  // ══════════════════════════════════════════════════
  //  Public API — Entity lifecycle
  // ══════════════════════════════════════════════════

  /**
   * Reserve an entity ID without placing it in any archetype.
   * Entity is alive immediately (isAlive() → true) but has zero components —
   * getComponent() returns undefined, queries won't see it.
   * Used by Commands.spawn() for immediate entity reservation with deferred archetype allocation.
   */
  reserveEntity(): Entity {
    const index = _freeSlots.length > 0 ? _freeSlots.pop()! : _entityState.nextSlot++;
    if (index >= getGenerations().length) {
      const oldGen = getGenerations();
      const newCap = Math.max(index + 256, getGenerations().length * 2);
      resizeGenerations(newCap);
      getGenerations().set(oldGen);
    }
    let gen = (getGenerations()[index] + 1) & GEN_MASK;
    if (gen === 0) gen = 1;
    getGenerations()[index] = gen;
    this._entityCount++;
    return packEntity(index, gen);
  }

  /**
   * @internal Complete a deferred spawn — add components to a pre-reserved entity.
   * Called by Commands during applyCommands() flush. Does NOT allocate a new entity ID.
   */
  _finishSpawn(entity: Entity, components: Component[]): void {
    if (components.length === 0) return;
    const kinds = [...new Set(components.map((c) => c.type))].sort();
    const tick = this._nextTick();
    const arch = this._findOrCreateArchetype(kinds);
    const row = arch.entities.length;
    arch.entities.push(entity);
    const kindMap = new Map(components.map((c) => [c.type, c]));
    for (let ci = 0; ci < kinds.length; ci++) {
      const kind = kinds[ci];
      const c = kindMap.get(kind)!;
      const { type: _type, ...data } = c as Record<string, unknown>;
      arch.columns[ci].push(data);
      arch.addedTicks[ci].push(tick);
      arch.changedTicks[ci].push(tick);
      this._lastChangedTick.set(kind, tick);
    }
    arch.masterChanged.push(tick);
    arch.masterAdded.push(tick);
    this._entityIndex.set(entity, { archetypeId: arch.id, row });

    for (const kind of kinds) {
      this._fireHooks(this._onAddHooks.get(kind), entity);
    }
  }

  /**
   * Create an entity with components.
   * Immediate mode — entity is queryable on return. For deferred spawn, use Commands.
   */
  spawn(
    components?: Component[],
    overrides?: Record<string, Partial<Record<string, unknown>>>,
  ): Entity {
    const entity = this.reserveEntity();
    const cs = components ?? [];
    let merged: Component[];
    if (overrides) {
      merged = cs.map((c) => {
        const patch = overrides[c.type] as Record<string, unknown> | undefined;
        return patch ? ({ ...c, ...patch } as Component) : c;
      });
      for (const [kind, data] of Object.entries(overrides)) {
        if (!cs.some((c) => c.type === kind)) {
          merged.push({ type: kind, ...data } as unknown as Component);
        }
      }
    } else {
      merged = cs;
    }
    if (merged.length > 0) this._finishSpawn(entity, merged);
    return entity;
  }

  /** Mark an entity as destroyed. Before-destroy hooks fire before generation bump —
   *  all components are still fully readable. _pendingDestroy prevents re-entrant cascade loops.
   *  Johnson §3.2 p53: finalizer callbacks synchronized with lifecycle phases. */
  destroy(entity: Entity): void {
    if (!this.isAlive(entity)) return;
    if (this._pendingDestroy?.has(entity)) return;
    (this._pendingDestroy ??= new Set()).add(entity);

    for (const cb of this._onBeforeDestroyHooks) {
      cb(entity);
    }

    this._pendingDestroy.delete(entity);

    const idx = entityIndex(entity);
    let gen = (getGenerations()[idx] + 1) & GEN_MASK;
    if (gen === 0) gen = 1;
    getGenerations()[idx] = gen;
    _freeSlots.push(idx);
    this._entityCount--;
    this._deferredDestroys.push(entity);
  }

  /** Register a before-destroy callback. Returns an unsubscribe function. */
  onBeforeDestroy(cb: (entity: Entity) => void): () => void {
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
  onAdd(factory: ComponentFactory<unknown> | string, cb: (entity: Entity) => void): () => void {
    const kind = typeof factory === "string" ? factory : factory.kind;
    let hooks = this._onAddHooks.get(kind);
    if (!hooks) {
      hooks = new Set();
      this._onAddHooks.set(kind, hooks);
    }
    hooks.add(cb);
    return () => {
      hooks!.delete(cb);
    };
  }

  /**
   * Register an on_remove hook for a component kind (Bevy-aligned).
   * Fires when the component is **removed** from an entity.
   * Destroying an entity triggers on_remove for each of its components.
   */
  onRemove(
    factory: ComponentFactory<unknown> | string,
    cb: (entity: Entity, data?: Record<string, unknown>) => void,
  ): () => void {
    const kind = typeof factory === "string" ? factory : factory.kind;
    let hooks = this._onRemoveHooks.get(kind);
    if (!hooks) {
      hooks = new Set();
      this._onRemoveHooks.set(kind, hooks);
    }
    hooks.add(cb);
    return () => {
      hooks!.delete(cb);
    };
  }

  /** Returns true if the entity is alive. O(1) generation comparison (Gregory §17.5 handle pattern). */
  isAlive(entity: Entity): boolean {
    return getGenerations()[entityIndex(entity)] === entityGen(entity);
  }

  entityCount(): number {
    return this._entityCount;
  }

  // ══════════════════════════════════════════════════
  //  Public API — World resources (Bevy-style Res<T>)
  // ══════════════════════════════════════════════════

  /**
   * Insert or replace a world resource.
   * - ResourceFactory → stored as component on a dedicated singleton entity (tick-tracked).
   * - ComponentFactory → fallback _resources map (backward compat).
   */
  // oxlint-disable-next-line typescript/no-explicit-any -- 泛型约束方法逆变必要
  insertResource<F extends ComponentFactory<unknown> | ResourceFactory<any>>(
    factory: F,
    data: DataOf<F>,
  ): void {
    if ("_comp" in factory) {
      // ResourceFactory — entity-based storage with automatic tick tracking
  // oxlint-disable-next-line typescript/no-explicit-any -- 泛型约束方法逆变必要
      const rf = factory as ResourceFactory<any>;
      const entity = this._resourceEntities.get(rf.kind);
      const comp = rf._comp({ _value: data } as unknown as { _value: unknown });
      if (entity && this.isAlive(entity)) {
        this.setComponent(entity, comp);
      } else {
        const newEntity = this.spawn([comp]);
        this._resourceEntities.set(rf.kind, newEntity);
      }
    } else {
      this._resources.set(factory.kind, data);
    }
  }

  /** Read a world resource. Returns undefined if the resource hasn't been inserted. */
  // oxlint-disable-next-line typescript/no-explicit-any -- 泛型约束方法逆变必要
  resource<F extends ComponentFactory<unknown> | ResourceFactory<any>>(
    factory: F,
  ): DataOf<F> | undefined {
    if ("_comp" in factory) {
      const entity = this._resourceEntities.get(factory.kind);
      if (!entity) return undefined;
      const comp = this.getComponent(entity, factory._comp);
      return comp?._value as DataOf<F> | undefined;
    }
    return this._resources.get(factory.kind) as DataOf<F> | undefined;
  }

  /** Remove a world resource. No-op if it doesn't exist. */
  // oxlint-disable-next-line typescript/no-explicit-any -- 泛型约束方法逆变必要
  removeResource<F extends ComponentFactory<unknown> | ResourceFactory<any>>(
    factory: F,
  ): void {
    if ("_comp" in factory) {
      const entity = this._resourceEntities.get(factory.kind);
      if (entity) {
        this.destroy(entity);
        this._resourceEntities.delete(factory.kind);
      }
    } else {
      this._resources.delete(factory.kind);
    }
  }

  /** Check whether a world resource has been inserted. */
  // oxlint-disable-next-line typescript/no-explicit-any -- 泛型约束方法逆变必要
  hasResource<F extends ComponentFactory<unknown> | ResourceFactory<any>>(
    factory: F,
  ): boolean {
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
  // oxlint-disable-next-line typescript/no-explicit-any -- 泛型约束方法逆变必要
  resourceChanged<F extends ResourceFactory<any>>(factory: F): boolean {
    const entity = this._resourceEntities.get(factory.kind);
    if (!entity) return false;
    const entry = this._getComponentEntryRaw(entity, factory.kind);
    if (!entry) return false;
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
  // oxlint-disable-next-line typescript/no-explicit-any -- 泛型约束方法逆变必要
  markResourceChanged<F extends ResourceFactory<any>>(factory: F): void {
    const entity = this._resourceEntities.get(factory.kind);
    if (!entity) return;
    const raw = this._getComponentRaw(entity, factory.kind);
    if (!raw) return;
    // Re-write the same data to bump changedTick (same mechanism as setComponent)
    this._writeComponent(entity, { type: factory.kind, ...raw });
  }

  // ══════════════════════════════════════════════════
  //  Public API — Component operations
  // ══════════════════════════════════════════════════

  addComponent(entity: Entity, component: Component): void {
    if (!this.isAlive(entity)) return;
    this._writeComponent(entity, component);
  }

  setComponent(entity: Entity, component: Component): void {
    if (!this.isAlive(entity)) return;
    this._writeComponent(entity, component);
  }

  patchComponent<Data>(
    entity: Entity,
    factory: ComponentFactory<Data>,
    patch: Partial<Data>,
  ): void {
    if (!this.isAlive(entity)) return;
    const existing = this.getComponent(entity, factory);
    if (existing) {
      this.setComponent(entity, factory.create({ ...existing, ...patch } as Partial<Data>));
    } else {
      this.setComponent(entity, factory.create(patch));
    }
  }

  /** Read a component. O(1): entity_index → archetype + row → component_index → column[row].
   *  Mertens: two map lookups + one array access. */
  getComponent<Data>(entity: Entity, factory: ComponentFactory<Data>): Data | undefined {
    return this._getComponentRaw(entity, factory.kind) as unknown as Data | undefined;
  }

  /** Read a component entry with its ticks. */
  getComponentEntry<Data>(
    entity: Entity,
    factory: ComponentFactory<Data>,
  ): { data: Data; addedTick: number; changedTick: number } | undefined {
    return this._getComponentEntryRaw(entity, factory.kind) as
      | { data: Data; addedTick: number; changedTick: number }
      | undefined;
  }

  /** Check whether an entity has a component of the given factory's kind. */
  hasComponent(entity: Entity, factory: ComponentFactory<unknown>): boolean {
    return this._hasComponentInternal(entity, factory.kind);
  }

  /** @internal Check by type string — used by Commands.insertIfNew. */
  _hasComponentKind(entity: Entity, kind: string): boolean {
    return this._hasComponentInternal(entity, kind);
  }

  /** Remove a component from an entity. */
  removeComponent(entity: Entity, factory: ComponentFactory<unknown>): void {
    if (!this.isAlive(entity)) return;
    this._deleteComponent(entity, factory.kind);
  }

  // ══════════════════════════════════════════════════
  //  Public API — Query (returns Entity[] snapshots)
  // ══════════════════════════════════════════════════

  // world.query(Pos, Vel).forEach((pos, vel, entity) => { ... })
  query: <const F extends readonly ComponentFactory<unknown>[]>(
    this: World,
    ...factories: F
  ) => Query<F>;
  /** Drain removed-component buffer for the given factory. Clears after each call. */
  removed: <D>(factory: ComponentFactory<D>) => Entity[];

  constructor() {
    // eslint-disable-next-line typescript/no-this-alias — needed for closure capture in ES5-compatible constructor
    const w = this;
    const queryFn = function <const F extends readonly ComponentFactory<unknown>[]>(
      this: World,
      ...factories: F
    ): Query<F> {
      if (factories.length === 0) {
        return {
          forEach() {},
          batch() {},
          entities() {
            return [];
          },
          first() {
            return undefined;
          },
          filter() {
            return this;
          },
        } as unknown as Query<F>;
      }

      /** Intersect archetype maps of all factories + With filters, exclude Without.
       *  Seeds from the SMALLEST map (fewer membership checks). Returns empty set
       *  when no archetype qualifies; null when a component kind is unknown. */
      function computeCandidates(
        factories: readonly ComponentFactory<unknown>[],
        withFilters: QueryFilter[],
        withoutFilters: QueryFilter[],
      ): Set<number> | null {
        let smallest: Map<number, number> | null = null;
        for (const f of factories) {
          const m = w._componentIndex.get(f.kind);
          if (!m) return null;
          if (smallest === null || m.size < smallest.size) smallest = m;
        }
        const candidate = new Set(smallest!.keys());
        for (const f of factories) {
          const m = w._componentIndex.get(f.kind)!;
          if (m === smallest) continue;
          for (const id of candidate) {
            if (!m.has(id)) candidate.delete(id);
          }
          if (candidate.size === 0) return candidate;
        }
        for (const f of withFilters) {
          const m = w._componentIndex.get(f.factory.kind);
          if (!m) return null;
          for (const id of candidate) {
            if (!m.has(id)) candidate.delete(id);
          }
          if (candidate.size === 0) return candidate;
        }
        for (const f of withoutFilters) {
          const m = w._componentIndex.get(f.factory.kind);
          if (m) {
            for (const id of candidate) {
              if (m.has(id)) candidate.delete(id);
            }
            if (candidate.size === 0) return candidate;
          }
        }
        return candidate;
      }

      /** True when archetype rows may contain dead entities (destroy → flush window).
       *  When false, per-row isAlive checks are skipped entirely. */
      const aliveCheck = (): boolean => w._deferredDestroys.length > 0;

      /** Inline generation check — local Uint16Array ref, no method calls (JIT-friendly). */
      const isAliveFast = (
        e: Entity,
        gens: Uint16Array,
      ): boolean => gens[(e >>> GEN_BITS) & INDEX_MASK] === (e & GEN_MASK);

      /** No-filter row loop, arity-specialized. Kept as a separate function so the
       *  JIT can optimize the hot loop independently of the large forEach body
       *  (measured: inlining it in forEach produced bimodal tiers — 2.5x faster
       *  or 1.45x slower than baseline depending on JIT luck). */
      function runFastRows(
        arch: Archetype,
        colIdxs: number[],
        needAlive: boolean,
        gens: Uint16Array,
        cb: (...data: unknown[]) => void,
      ): void {
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
          const d0 = (arch.columns[colIdxs[0]] as ObjectColumn).rawData() as Record<string, unknown>[];
          if (!needAlive) {
            for (let row = 0; row < count; row++) cb(d0[row], ents[row]);
          } else {
            for (let row = 0; row < count; row++) {
              const e = ents[row];
              if (gens[(e >>> GEN_BITS) & INDEX_MASK] === (e & GEN_MASK)) cb(d0[row], e);
            }
          }
        } else if (!hasF64 && n === 2) {
          const d0 = (arch.columns[colIdxs[0]] as ObjectColumn).rawData() as Record<string, unknown>[];
          const d1 = (arch.columns[colIdxs[1]] as ObjectColumn).rawData() as Record<string, unknown>[];
          if (!needAlive) {
            for (let row = 0; row < count; row++) cb(d0[row], d1[row], ents[row]);
          } else {
            for (let row = 0; row < count; row++) {
              const e = ents[row];
              if (gens[(e >>> GEN_BITS) & INDEX_MASK] === (e & GEN_MASK)) cb(d0[row], d1[row], e);
            }
          }
        } else if (!hasF64 && n === 3) {
          const d0 = (arch.columns[colIdxs[0]] as ObjectColumn).rawData() as Record<string, unknown>[];
          const d1 = (arch.columns[colIdxs[1]] as ObjectColumn).rawData() as Record<string, unknown>[];
          const d2 = (arch.columns[colIdxs[2]] as ObjectColumn).rawData() as Record<string, unknown>[];
          if (!needAlive) {
            for (let row = 0; row < count; row++) cb(d0[row], d1[row], d2[row], ents[row]);
          } else {
            for (let row = 0; row < count; row++) {
              const e = ents[row];
              if (gens[(e >>> GEN_BITS) & INDEX_MASK] === (e & GEN_MASK))
                cb(d0[row], d1[row], d2[row], e);
            }
          }
        } else {
          // Generic: any float64 column or arity > 3 — lazy per-row access
          const lazyCols = colIdxs.map((ci) => {
            const col = arch.columns[ci];
            if (col.isFloat64) return { f64: col, raw: null as null };
            return { f64: null, raw: (col as ObjectColumn).rawData() as Record<string, unknown>[] };
          });
          const a0 = lazyCols[0];
          const a1 = lazyCols[1];
          const a2 = lazyCols[2];
          const v = (c: { raw: Record<string, unknown>[] | null; f64: Column | null }, row: number) =>
            c.raw !== null ? c.raw[row] : c.f64!.get(row);
          if (!needAlive) {
            for (let row = 0; row < count; row++) {
              const e = ents[row];
              if (n === 1) {
                cb(v(a0, row), e);
              } else if (n === 2) {
                cb(v(a0, row), v(a1, row), e);
              } else if (n === 3) {
                cb(v(a0, row), v(a1, row), v(a2, row), e);
              } else {
                cb(...lazyCols.map((c) => v(c, row)), e);
              }
            }
          } else {
            for (let row = 0; row < count; row++) {
              const e = ents[row];
              if (gens[(e >>> GEN_BITS) & INDEX_MASK] !== (e & GEN_MASK)) continue;
              if (n === 1) {
                cb(v(a0, row), e);
              } else if (n === 2) {
                cb(v(a0, row), v(a1, row), e);
              } else if (n === 3) {
                cb(v(a0, row), v(a1, row), v(a2, row), e);
              } else {
                cb(...lazyCols.map((c) => v(c, row)), e);
              }
            }
          }
        }
      }

      /** No-filter batch snapshot + callback. Separate function (same JIT rationale as
       *  runFastRows): the large batch body with row-filtered tick logic degrades
       *  the no-filter snapshot loop's tiering when inlined. */
      function runFastBatch(
        arch: Archetype,
        colIdxs: number[],
        needAlive: boolean,
        gens: Uint16Array,
        cb: (...cols: unknown[]) => void,
      ): void {
        const n = factories.length;
        const ents = arch.entities;
        const count = ents.length;
        // Hoist column refs: raw arrays for ObjectColumn, column for Float64Column
        const rawCols: (Record<string, unknown>[] | null)[] = new Array(n);
        const f64Cols: (Column | null)[] = new Array(n);
        for (let ci = 0; ci < n; ci++) {
          const col = arch.columns[colIdxs[ci]];
          if (col.isFloat64) {
            rawCols[ci] = null;
            f64Cols[ci] = col;
          } else {
            rawCols[ci] = (col as ObjectColumn).rawData() as Record<string, unknown>[];
            f64Cols[ci] = null;
          }
        }
        const entsSnap: Entity[] = new Array<Entity>(count).fill(null as never);
        const colsSnap = new Array<Record<string, unknown>[]>(n);
        for (let ci = 0; ci < n; ci++) colsSnap[ci] = new Array<Record<string, unknown>>(count).fill(null as never);
        let len = 0;
        if (!needAlive) {
          for (let row = 0; row < count; row++) {
            entsSnap[len] = ents[row];
            for (let ci = 0; ci < n; ci++) {
              const raw = rawCols[ci];
              colsSnap[ci][len] = raw !== null ? raw[row] : f64Cols[ci]!.get(row);
            }
            len++;
          }
        } else {
          for (let row = 0; row < count; row++) {
            const e = ents[row];
            if (gens[(e >>> GEN_BITS) & INDEX_MASK] !== (e & GEN_MASK)) continue;
            entsSnap[len] = e;
            for (let ci = 0; ci < n; ci++) {
              const raw = rawCols[ci];
              colsSnap[ci][len] = raw !== null ? raw[row] : f64Cols[ci]!.get(row);
            }
            len++;
          }
        }
        if (len > 0) cb(...colsSnap, entsSnap, len);
      }

      function makeQuery(filters: QueryFilter[]): Query<F> {
        // Separate filters: archetype-level (With/Without) vs row-level (Changed/Added)
        const withFilters = filters.filter((f) => f.kind === "with");
        const withoutFilters = filters.filter((f) => f.kind === "without");
        const changedFilters = filters.filter((f) => f.kind === "changed");
        const addedFilters = filters.filter((f) => f.kind === "added");

        // ── Query 候选缓存（Bevy QueryState 等价）──
        // key = factories + With + Without（Changed/Added 是行级，不影响 archetype 候选）
        const cacheKey =
          factories.map((f) => f.kind).join(",") +
          "|w:" + withFilters.map((f) => f.factory.kind).join(",") +
          "|o:" + withoutFilters.map((f) => f.factory.kind).join(",");
        // 单个新 archetype 是否匹配本查询（Bevy QueryState::new_archetype 等价）
        function matchesArchetype(arch: Archetype): boolean {
          const kinds = arch.type;
          for (const f of factories) if (!kinds.includes(f.kind)) return false;
          for (const f of withFilters) if (!kinds.includes(f.factory.kind)) return false;
          for (const f of withoutFilters) if (kinds.includes(f.factory.kind)) return false;
          return true;
        }
        let cachedCandidates: Set<number> | null | undefined; // undefined=未算
        function getCandidates(): Set<number> | null {
          if (cachedCandidates !== undefined) return cachedCandidates;
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
              if (arch && matchesArchetype(arch)) entry.candidates.add(arch.id);
            }
            entry.gen = curGen;
            cachedCandidates = entry.candidates;
            return cachedCandidates;
          }
          // 首次：全量交集（含组件 kind 未知 → null 不缓存）
          const r = computeCandidates(factories, withFilters, withoutFilters);
          if (r !== null) w._queryCache.set(cacheKey, { gen: curGen, candidates: r });
          cachedCandidates = r;
          return r;
        }

        return {
          forEach(callback: (...data: unknown[]) => void): void {
            const candidate = getCandidates();
            if (!candidate || candidate.size === 0) return;
            const n = factories.length;
            const needAlive = aliveCheck();
            const gens = getGenerations();
            const cb = callback;
            const hasRowFilters = changedFilters.length > 0 || addedFilters.length > 0;

            // Hoist per-factory archetype maps (stable within the query call)
            const compIdx = new Array<Map<number, number>>(n);
            for (let i = 0; i < n; i++) {
              compIdx[i] = w._componentIndex.get(factories[i].kind)!;
            }

            for (const archId of candidate) {
              const arch = w._archetypes.get(archId)!;
              const count = arch.entities.length;
              if (count === 0) continue;
              const ents = arch.entities;

              // Resolve column indices once per archetype (each archetype visited once)
              const colIdxs = new Array<number>(n);
              for (let i = 0; i < n; i++) colIdxs[i] = compIdx[i].get(archId)!;

              if (hasRowFilters) {
                // Resolve filter column indices (may be undefined if archetype lacks component)
                const changedColIdxs = changedFilters.map((f) =>
                  w._componentIndex.get(f.factory.kind)?.get(archId),
                );
                const addedColIdxs = addedFilters.map((f) =>
                  w._componentIndex.get(f.factory.kind)?.get(archId),
                );

                // Lazy data: pre-get raw arrays for ObjectColumns, reference get() for Float64Columns
                const lazyCols = colIdxs.map((ci) => {
                  const col = arch.columns[ci];
                  if (col.isFloat64) return { f64: col, raw: null as null };
                  return { f64: null, raw: (col as ObjectColumn).rawData() as Record<string, unknown>[] };
                });

                for (let row = 0; row < count; row++) {
                  const e = ents[row];
                  if (needAlive && !isAliveFast(e, gens)) continue;

                  // Fast path: master tick — skip if nothing changed since last check
                  if (
                    (changedFilters.length > 0 &&
                      arch.masterChanged[row] <=
                        w._getLastSeenMaster(w._seenChangedMaster, e)) ||
                    (addedFilters.length > 0 &&
                      arch.masterAdded[row] <= w._getLastSeenMaster(w._seenAddedMaster, e))
                  ) {
                    const mtC = arch.masterChanged[row],
                      mtA = arch.masterAdded[row];
                    if (changedFilters.length > 0 && mtC > 0)
                      w._setLastSeenMaster(w._seenChangedMaster, e, mtC);
                    if (addedFilters.length > 0 && mtA > 0)
                      w._setLastSeenMaster(w._seenAddedMaster, e, mtA);
                    continue;
                  }

                  // Changed: ANY specified component changed (OR)
                  if (changedFilters.length > 0) {
                    w._setLastSeenMaster(w._seenChangedMaster, e, arch.masterChanged[row]);
                    let anyChanged = false;
                    for (let fi = 0; fi < changedFilters.length; fi++) {
                      const ci = changedColIdxs[fi];
                      if (ci === undefined) continue;
                      const tick = arch.changedTicks[ci][row];
                      const lastSeen = w._getLastSeenChanged(
                        e,
                        changedFilters[fi].factory.kind,
                      );
                      if (tick > lastSeen) {
                        anyChanged = true;
                        w._setLastSeenChanged(e, changedFilters[fi].factory.kind, tick);
                      }
                    }
                    if (!anyChanged) continue;
                  }
                  // Added: ANY specified must have been added (OR)
                  if (addedFilters.length > 0) {
                    let anyAdded = false;
                    for (let fi = 0; fi < addedFilters.length; fi++) {
                      const ci = addedColIdxs[fi];
                      if (ci === undefined) continue;
                      const tick = arch.addedTicks[ci][row];
                      const lastSeen = w._getLastSeenAdded(e, addedFilters[fi].factory.kind);
                      if (tick > lastSeen) {
                        anyAdded = true;
                        w._setLastSeenAdded(e, addedFilters[fi].factory.kind, tick);
                      }
                    }
                    if (!anyAdded) continue;
                  }

                  // All filters passed: access data lazily (only for this row)
                  if (n === 1) {
                    cb(lazyCols[0].raw ? lazyCols[0].raw[row] : lazyCols[0].f64!.get(row), e);
                  } else if (n === 2) {
                    cb(
                      lazyCols[0].raw ? lazyCols[0].raw[row] : lazyCols[0].f64!.get(row),
                      lazyCols[1].raw ? lazyCols[1].raw[row] : lazyCols[1].f64!.get(row),
                      e,
                    );
                  } else if (n === 3) {
                    cb(
                      lazyCols[0].raw ? lazyCols[0].raw[row] : lazyCols[0].f64!.get(row),
                      lazyCols[1].raw ? lazyCols[1].raw[row] : lazyCols[1].f64!.get(row),
                      lazyCols[2].raw ? lazyCols[2].raw[row] : lazyCols[2].f64!.get(row),
                      e,
                    );
                  } else {
                    cb(...lazyCols.map((c) => (c.raw ? c.raw[row] : c.f64!.get(row))), e);
                  }
                }
                continue;
              }

              // ── No row filters: delegate to the specialized fast path ──
              runFastRows(arch, colIdxs, needAlive, gens, cb);
            }
          },

          batch(callback: (...cols: unknown[]) => void): void {
            const candidate = getCandidates();
            if (!candidate || candidate.size === 0) return;
            const n = factories.length;
            const needAlive = aliveCheck();
            const gens = getGenerations();
            const hasRowFilters = changedFilters.length > 0 || addedFilters.length > 0;

            const compIdx = new Array<Map<number, number>>(n);
            for (let i = 0; i < n; i++) {
              compIdx[i] = w._componentIndex.get(factories[i].kind)!;
            }

            for (const archId of candidate) {
              const arch = w._archetypes.get(archId)!;
              const count = arch.entities.length;
              if (count === 0) continue;
              const ents = arch.entities;

              const colIdxs = new Array<number>(n);
              for (let i = 0; i < n; i++) colIdxs[i] = compIdx[i].get(archId)!;

              if (hasRowFilters) {
                const changedColIdxs = changedFilters.map((f) =>
                  w._componentIndex.get(f.factory.kind)?.get(archId),
                );
                const addedColIdxs = addedFilters.map((f) =>
                  w._componentIndex.get(f.factory.kind)?.get(archId),
                );
                // Build filtered snapshot arrays (preallocated)
                const aliveEnts: Entity[] = new Array<Entity>(count).fill(null as never);
                const aliveCols = new Array<Record<string, unknown>[]>(n);
                for (let ci = 0; ci < n; ci++) aliveCols[ci] = new Array<Record<string, unknown>>(count).fill(null as never);
                const rawCols: (Record<string, unknown>[] | null)[] = new Array(n);
                const f64Cols: (Column | null)[] = new Array(n);
                for (let ci = 0; ci < n; ci++) {
                  const col = arch.columns[colIdxs[ci]];
                  if (col.isFloat64) {
                    rawCols[ci] = null;
                    f64Cols[ci] = col;
                  } else {
                    rawCols[ci] = (col as ObjectColumn).rawData() as Record<string, unknown>[];
                    f64Cols[ci] = null;
                  }
                }
                let len = 0;
                for (let row = 0; row < count; row++) {
                  const e = ents[row];
                  if (needAlive && !isAliveFast(e, gens)) continue;
                  // Changed check (OR)
                  if (changedFilters.length > 0) {
                    let anyChanged = false;
                    for (let fi = 0; fi < changedFilters.length; fi++) {
                      const ci = changedColIdxs[fi];
                      if (ci === undefined) continue;
                      const tick = arch.changedTicks[ci][row];
                      if (tick > w._getLastSeenChanged(e, changedFilters[fi].factory.kind)) {
                        anyChanged = true;
                        w._setLastSeenChanged(e, changedFilters[fi].factory.kind, tick);
                      }
                    }
                    if (!anyChanged) continue;
                  }
                  // Added check (OR)
                  if (addedFilters.length > 0) {
                    let anyAdded = false;
                    for (let fi = 0; fi < addedFilters.length; fi++) {
                      const ci = addedColIdxs[fi];
                      if (ci === undefined) continue;
                      const tick = arch.addedTicks[ci][row];
                      if (tick > w._getLastSeenAdded(e, addedFilters[fi].factory.kind)) {
                        anyAdded = true;
                        w._setLastSeenAdded(e, addedFilters[fi].factory.kind, tick);
                      }
                    }
                    if (!anyAdded) continue;
                  }
                  aliveEnts[len] = e;
                  for (let ci = 0; ci < n; ci++) {
                    const raw = rawCols[ci];
                    aliveCols[ci][len] = raw !== null ? raw[row] : f64Cols[ci]!.get(row);
                  }
                  len++;
                }
                if (len > 0) callback(...aliveCols, aliveEnts, len);
                continue;
              }

              // ── No row filters: snapshot matching rows before invoking the callback.
              //    The callback may mutate the queried archetype (e.g. add a component to
              //    a matched entity → it moves to another archetype and swap-removes rows
              //    from the live arrays). Iterating live arrays under mutation yields
              //    undefined rows (regression: GeometrySystem specSig crash). ──
              runFastBatch(arch, colIdxs, needAlive, gens, callback);
            }
          },

          entities(): Entity[] {
            const candidate = getCandidates();
            if (!candidate || candidate.size === 0) return [];
            const needAlive = aliveCheck();
            const gens = getGenerations();
            const hasRowFilters = changedFilters.length > 0 || addedFilters.length > 0;
            const result: Entity[] = [];
            for (const archId of candidate) {
              const arch = w._archetypes.get(archId)!;
              const count = arch.entities.length;
              if (hasRowFilters) {
                const changedColIdxs = changedFilters.map((f) =>
                  w._componentIndex.get(f.factory.kind)?.get(archId),
                );
                const addedColIdxs = addedFilters.map((f) =>
                  w._componentIndex.get(f.factory.kind)?.get(archId),
                );
                for (let row = 0; row < count; row++) {
                  const e = arch.entities[row];
                  if (needAlive && !isAliveFast(e, gens)) continue;
                  if (changedFilters.length > 0) {
                    let anyChanged = false;
                    for (let fi = 0; fi < changedFilters.length; fi++) {
                      const ci = changedColIdxs[fi];
                      if (ci === undefined) continue;
                      const tick = arch.changedTicks[ci][row];
                      const lastSeen = w._getLastSeenChanged(
                        e,
                        changedFilters[fi].factory.kind,
                      );
                      if (tick > lastSeen) {
                        anyChanged = true;
                        w._setLastSeenChanged(e, changedFilters[fi].factory.kind, tick);
                      }
                    }
                    if (!anyChanged) continue;
                  }
                  if (addedFilters.length > 0) {
                    let anyAdded = false;
                    for (let fi = 0; fi < addedFilters.length; fi++) {
                      const ci = addedColIdxs[fi];
                      if (ci === undefined) continue;
                      const tick = arch.addedTicks[ci][row];
                      const lastSeen = w._getLastSeenAdded(e, addedFilters[fi].factory.kind);
                      if (tick > lastSeen) {
                        anyAdded = true;
                        w._setLastSeenAdded(e, addedFilters[fi].factory.kind, tick);
                      }
                    }
                    if (!anyAdded) continue;
                  }
                  result.push(e);
                }
              } else {
                if (!needAlive) {
                  for (let row = 0; row < count; row++) result.push(arch.entities[row]);
                } else {
                  const ents = arch.entities;
                  for (let row = 0; row < count; row++) {
                    const e = ents[row];
                    if (gens[(e >>> GEN_BITS) & INDEX_MASK] === (e & GEN_MASK)) result.push(e);
                  }
                }
              }
            }
            return result;
          },

          first(): Entity | undefined {
            const candidate = getCandidates();
            if (!candidate || candidate.size === 0) return undefined;
            const needAlive = aliveCheck();
            const gens = getGenerations();
            for (const archId of candidate) {
              const arch = w._archetypes.get(archId)!;
              const ents = arch.entities;
              if (!needAlive) {
                if (ents.length > 0) return ents[0];
              } else {
                for (let row = 0; row < ents.length; row++) {
                  const e = ents[row];
                  if (gens[(e >>> GEN_BITS) & INDEX_MASK] === (e & GEN_MASK)) return e;
                }
              }
            }
            return undefined;
          },

          filter(...more: QueryFilter[]): Query<F> {
            return makeQuery([...filters, ...more]);
          },
        } as Query<F>;
      }

      return makeQuery([]);
    };

    this.query = queryFn;


    // ── Removed component buffer (drain-based, not query-based) ──
    this.removed = <D>(factory: ComponentFactory<D>): Entity[] => {
      const cid = _kindIds.get(factory.kind);
      if (cid === undefined) return [];
      const set = w._removedBuffer[cid];
      if (!set || set.size === 0) return [];
      const result = [...set];
      set.clear();
      return result;
    };
  }

  // ══════════════════════════════════════════════════
  //  Public API — Sync
  // ══════════════════════════════════════════════════

  _clearRemoved(): void {
    for (const set of this._removedBuffer) {
      if (set) set.clear();
    }
  }

  /** @internal Enqueue a deferred command closure. Used by Commands class. */
  _enqueue(fn: () => void): void {
    this._commands.push(fn);
  }

  /** Apply all pending commands (structural mutations). No-op when there are no
   *  deferred commands — the engine calls this after each system for safety. */
  applyCommands(): void {
    if (this._commands.length === 0) return;
    for (const cmd of this._commands) cmd();
    this._commands.length = 0;
  }

  flushDestroyed(): void {
    this._flushDestroys();
  }

  get hasKilledEntities(): boolean {
    return this._killedThisFrame.length > 0;
  }

  /** Highest tick at which component `kind` was changed. For dirty-check fast path. */
  lastChangedTick(kind: string): number {
    return this._lastChangedTick.get(kind) ?? 0;
  }

  drainKilled(): Entity[] {
    const result = this._killedThisFrame;
    this._killedThisFrame = [];
    return result;
  }

  // ══════════════════════════════════════════════════
  //  Public API — Engine interface
  // ══════════════════════════════════════════════════

  get tick(): number {
    return this._tick;
  }

  setCurrentObserver(name: string | null): void {
    this._currentObserver = name;
  }

  isAnyDirty(kinds: string[], sinceTick: number): boolean {
    for (let i = 0; i < kinds.length; i++) {
      const lastChanged = this._lastChangedTick.get(kinds[i]);
      if (lastChanged !== undefined && lastChanged > sinceTick) return true;
    }
    return false;
  }

  dumpEcs(): {
    entityCount: number;
    entities: Array<{
      eid: number;
      archetype: string[];
      components: string[];
      data: Record<string, unknown>;
    }>;
  } {
    const eMap = new Map<
      Entity,
      { comps: Set<string>; data: Record<string, unknown>; kinds: Set<string> }
    >();
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
        for (const k of arch.type) item.kinds.add(k);
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

  _debugKinds(): string[] {
    return _kindOrder.slice();
  }

  _debugGetComponentRaw(entity: Entity, kind: string): Record<string, unknown> | undefined {
    const data = this._getComponentRaw(entity, kind);
    return data ? { ...data } : undefined;
  }

  // ═══════════════════════════════════════════════════════════
  //  Private — archetype management
  // ═══════════════════════════════════════════════════════════

  private _nextTick(): number {
    return ++this._tick;
  }

  /** Find or create an archetype for a sorted set of component kinds.
   *  Phase 2: kinds with a registered schema get Float64Column, others ObjectColumn. */
  private _findOrCreateArchetype(kinds: string[]): Archetype {
    const key = _typeKey(kinds);
    let archId = this._archetypeIndex.get(key);
    if (archId !== undefined) return this._archetypes.get(archId)!;

    archId = this._nextArchetypeId++;
    const columns = kinds.map((k) => {
      const schema = _schemas.get(k);
      return schema ? new Float64Column(schema) : new ObjectColumn();
    });
    const arch: Archetype = {
      id: archId,
      type: kinds,
      columns,
      entities: [],
      addedTicks: [],
      changedTicks: [],
      masterChanged: [],
      masterAdded: [],
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
  _getComponentRaw(entity: Entity, kind: string): Record<string, unknown> | undefined {
    // Bevy deferred despawn 语义：destroy→flush 窗口内组件仍可读
    // （on_remove 钩子回调需要读取其他组件；flush 后 _entityIndex 删除 → undefined）
    const rec = this._entityIndex.get(entity);
    if (!rec) return undefined;
    const compMap = this._componentIndex.get(kind);
    if (!compMap) return undefined;
    const colIdx = compMap.get(rec.archetypeId);
    if (colIdx === undefined) return undefined;
    const arch = this._archetypes.get(rec.archetypeId)!;
    return arch.columns[colIdx].get(rec.row);
  }

  private _getComponentEntryRaw(
    entity: Entity,
    kind: string,
  ): { data: Record<string, unknown>; addedTick: number; changedTick: number } | undefined {
    const rec = this._entityIndex.get(entity);
    if (!rec) return undefined;
    const compMap = this._componentIndex.get(kind);
    if (!compMap) return undefined;
    const colIdx = compMap.get(rec.archetypeId);
    if (colIdx === undefined) return undefined;
    const arch = this._archetypes.get(rec.archetypeId)!;
    return {
      data: arch.columns[colIdx].get(rec.row),
      addedTick: arch.addedTicks[colIdx][rec.row],
      changedTick: arch.changedTicks[colIdx][rec.row],
    };
  }

  /** O(1) — checks component_index for the archetype. */
  private _hasComponentInternal(entity: Entity, kind: string): boolean {
    // 同 _getComponentRaw：destroy→flush 窗口内可读（on_remove 钩子语义）
    const rec = this._entityIndex.get(entity);
    if (!rec) return false;
    return this._componentIndex.get(kind)?.has(rec.archetypeId) ?? false;
  }

  // ═══════════════════════════════════════════════════════════
  //  Private — component write/delete (now archetype-based)
  // ═══════════════════════════════════════════════════════════

  /** Write a component to an entity — handles both insert (new kind) and update (existing kind). */
  private _writeComponent(entity: Entity, component: Component): void {
    const kind = component.type;
    const tick = this._nextTick();
    const { type: _type, ...data } = component as Record<string, unknown>;
    const rec = this._entityIndex.get(entity);

    if (!rec) {
      // Entity has no components yet — create singleton archetype
      const arch = this._findOrCreateArchetype([kind]);
      arch.columns[0].push(data);
      arch.entities.push(entity);
      arch.addedTicks[0].push(tick);
      arch.changedTicks[0].push(tick);
      arch.masterAdded.push(tick);
      arch.masterChanged.push(tick);
      this._entityIndex.set(entity, { archetypeId: arch.id, row: arch.entities.length - 1 });
      this._lastChangedTick.set(kind, tick);
      return;
    }

    const oldArch = this._archetypes.get(rec.archetypeId)!;
    const compMap = this._componentIndex.get(kind);
    const existingColIdx = compMap?.get(oldArch.id);

    if (existingColIdx !== undefined) {
      // Update — component kind already present
      oldArch.columns[existingColIdx].set(rec.row, data);
      oldArch.changedTicks[existingColIdx][rec.row] = tick;
      if (oldArch.masterChanged[rec.row] < tick) oldArch.masterChanged[rec.row] = tick;
      this._lastChangedTick.set(kind, tick);
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
      } else {
        // Copy from old archetype
        const oci = this._componentIndex.get(nk)!.get(oldArch.id)!;
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
    this._fireHooks(this._onAddHooks.get(kind), entity);
  }

  /** Remove a component kind from an entity — moves to new archetype without that kind. */
  private _deleteComponent(entity: Entity, kind: string): void {
    // Fire on_remove hooks before removing (Bevy: Remove runs before component data is dropped)
    this._fireHooks(this._onRemoveHooks.get(kind), entity);
    const rec = this._entityIndex.get(entity);
    if (!rec) return;
    const oldArch = this._archetypes.get(rec.archetypeId)!;
    const colIdx = this._componentIndex.get(kind)?.get(oldArch.id);
    if (colIdx === undefined) return; // entity doesn't have this kind

    // Track removal
    const cid = _kindIds.get(kind);
    if (cid !== undefined) {
      let set = this._removedBuffer[cid];
      if (!set) {
        set = new Set();
        this._removedBuffer[cid] = set;
      }
      set.add(entity);
    }

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
      const oci = this._componentIndex.get(nk)!.get(oldArch.id)!;
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
  private _removeEntityFromArchetype(
    entity: Entity,
    rec: { archetypeId: number; row: number },
    arch: Archetype,
  ): void {
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
    } else {
      for (let ci = 0; ci < arch.type.length; ci++) {
        arch.columns[ci].swapRemove(rec.row);
        arch.addedTicks[ci].pop();
        arch.changedTicks[ci].pop();
      }
      arch.entities.pop();
    }
  }

  /** Batch cleanup of deferred destroys. */
  private _flushDestroys(): void {
    if (this._deferredDestroys.length === 0) return;
    for (const entity of this._deferredDestroys) this._killedThisFrame.push(entity);
    for (const entity of this._deferredDestroys) {
      const rec = this._entityIndex.get(entity);
      if (rec) {
        const arch = this._archetypes.get(rec.archetypeId)!;
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
      for (const obsMap of this._seenAdded.values()) obsMap.delete(entity);
      for (const obsMap of this._seenChanged.values()) obsMap.delete(entity);
    }

    this._deferredDestroys.length = 0;
  }

  /** Fire all hooks in a set for an entity. No-op if hooks is undefined/empty. */
  private _fireHooks(
    hooks: Set<(entity: Entity, data?: Record<string, unknown>) => void> | undefined,
    entity: Entity,
    data?: Record<string, unknown>,
  ): void {
    if (!hooks || hooks.size === 0) return;
    for (const cb of hooks) cb(entity, data);
  }

  // ── Observer tick tracking ──

  private _getLastSeenAdded(entity: Entity, kind: string): number {
    return (
      this._seenAdded
        .get(this._currentObserver ?? "__")
        ?.get(entity)
        ?.get(kind) ?? 0
    );
  }
  private _getLastSeenChanged(entity: Entity, kind: string): number {
    return (
      this._seenChanged
        .get(this._currentObserver ?? "__")
        ?.get(entity)
        ?.get(kind) ?? 0
    );
  }
  private _getLastSeenMaster(
    map: Map<string, Map<Entity, number>>,
    entity: Entity,
  ): number {
    return map.get(this._currentObserver ?? "__")?.get(entity) ?? 0;
  }
  private _setLastSeenMaster(
    map: Map<string, Map<Entity, number>>,
    entity: Entity,
    tick: number,
  ): void {
    const key = this._currentObserver ?? "__";
    let obs = map.get(key);
    if (!obs) {
      obs = new Map();
      map.set(key, obs);
    }
    obs.set(entity, Math.max(tick, obs.get(entity) ?? 0));
  }
  private _setLastSeenAdded(entity: Entity, kind: string, tick: number): void {
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
  private _setLastSeenChanged(entity: Entity, kind: string, tick: number): void {
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
