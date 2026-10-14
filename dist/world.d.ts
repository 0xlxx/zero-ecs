import type { Entity } from "./entity.js";
import type { ComponentFactory, ResourceFactory } from "./component.js";
import type { Component } from "./component.js";
import { QueryState } from "./query.js";
import type { Query } from "./query.js";
export declare class World {
    private _tick;
    private _entityCount;
    private _gens;
    /** Stable holder for query iterators: growth replaces gens without staling captured views. */
    private _genState;
    private _freeSlots;
    private _nextSlot;
    private _entityIndex;
    private _archetypes;
    private _componentIndex;
    private _archetypeIndex;
    private _nextArchetypeId;
    /** Archetype 结构代际——新增 archetype 时 +1，用于 query 候选缓存失效。 */
    private _archetypeGeneration;
    /** Query 候选缓存：key = factories+With+Without → { 代际, 匹配 archetype 集 }。
     *  稳态（无新 archetype）下消除每次 query 的交集重算（Bevy QueryState 等价）。 */
    private _queryCache;
    private _commands;
    /** Resource-kind → singleton entity. ResourceFactory resources are components on dedicated entities. */
    private _resourceEntities;
    /** Per-observer per-resource-kind last-seen changedTick. Auto-managed by resourceChanged(). */
    private _seenResourceTicks;
    /** Fallback storage for ComponentFactory-based resources (backward compat). */
    private _resources;
    private _deferredDestroys;
    /** Entities killed this frame. Populated by _flushDestroys; reset at frame end (setCurrentObserver(null)). */
    private _killedThisFrame;
    /** 上一帧 kill——Bevy RemovedComponents 双缓冲：kill 事件存活 2 帧，
     *  保证「排在 killer 之前」的系统下帧仍能看到（帧内排序无关）。 */
    private _killedPrevFrame;
    /** Per-observer consumed count into 逻辑流 [prev, thisFrame]（多读者游标）。 */
    private _killedCursor;
    /** Entities currently being destroyed — prevents re-entrant cascade loops. */
    private _pendingDestroy;
    private _onBeforeDestroyHooks;
    /** Per-kind on_add hooks. Fires when a component type is added to an entity for the first time. */
    private _onAddHooks;
    /** Per-kind on_remove hooks. Fires when a component type is removed from an entity. */
    private _onRemoveHooks;
    /** Per-kind change hooks. Fires once for each completed insert/replace write. */
    private changedHooks;
    /** Fast gate for the common no-hook write path. */
    private hasChangedHooks;
    /** Removal tracking grouped to keep the World object shape compact. */
    private _removedState;
    /** Guards against re-entrant removal of the same entity/component pair. */
    private _removingComponents;
    /** Structural changes that invalidate stage skip-if-clean without a component tick. */
    private _structuralDirtyTick;
    private _currentObserver;
    /** Per-kind highest changedTick — enables O(kinds) isAnyDirty (Johnson Ch5.1 cache-friendly). */
    private _lastChangedTick;
    private _seenAdded;
    private _seenChanged;
    /**
     * Reserve an entity ID without placing it in any archetype.
     * Entity is alive immediately (isAlive() → true) but has zero components —
     * getComponent() returns undefined, queries won't see it.
     * Used by Commands.spawn() for immediate entity reservation with deferred archetype allocation.
     */
    reserveEntity(): Entity;
    /**
     * @internal Complete a deferred spawn — add components to a pre-reserved entity.
     * Called by Commands during applyCommands() flush. Does NOT allocate a new entity ID.
     */
    _finishSpawn(entity: Entity, components: Component[]): void;
    /**
     * Create an entity with components.
     * Immediate mode — entity is queryable on return. For deferred spawn, use Commands.
     */
    spawn(components?: Component[], overrides?: Record<string, Partial<Record<string, unknown>>>): Entity;
    /** Mark an entity as destroyed. Before-destroy hooks fire before generation bump —
     *  all components are still fully readable. _pendingDestroy prevents re-entrant cascade loops.
     *  Johnson §3.2 p53: finalizer callbacks synchronized with lifecycle phases. */
    destroy(entity: Entity): void;
    /** Register a before-destroy callback. Returns an unsubscribe function. */
    onBeforeDestroy(cb: (entity: Entity) => void): () => void;
    /**
     * Register an on_add hook for a component kind (Bevy-aligned).
     * Fires when the component is **first added** to an entity that didn't have it.
     * Spawning an entity with the component triggers on_add.
     */
    onAdd(factory: ComponentFactory<unknown> | string, cb: (entity: Entity) => void): () => void;
    /**
     * Register an on_remove hook for a component kind (Bevy-aligned).
     * Fires when the component is **removed** from an entity.
     * Destroying an entity triggers on_remove for each of its components.
     */
    onRemove(factory: ComponentFactory<unknown> | string, cb: (entity: Entity, data?: Record<string, unknown>) => void): () => void;
    /**
     * Register a component-change hook.
     *
     * Runs exactly once for each completed insert or replacement of an existing
     * component. It does not run for removals. Hooks are isolated: one throwing
     * callback does not prevent the remaining callbacks or the structural write.
     */
    onChanged(factory: ComponentFactory<unknown> | string, cb: (entity: Entity, data?: Record<string, unknown>) => void): () => void;
    /** Alias for onChanged — the component was set/inserted. */
    onSet(factory: ComponentFactory<unknown> | string, cb: (entity: Entity, data?: Record<string, unknown>) => void): () => void;
    /** Returns true if the entity is alive. O(1) generation comparison (Gregory §17.5 handle pattern). */
    isAlive(entity: Entity): boolean;
    entityCount(): number;
    /**
     * Insert or replace a world resource.
     * - ResourceFactory → stored as component on a dedicated singleton entity (tick-tracked).
     * - ComponentFactory → fallback _resources map (backward compat).
     */
    insertResource<D>(factory: ResourceFactory<D>, data: D): void;
    insertResource<D>(factory: ComponentFactory<D>, data: D): void;
    /** Read a world resource. Returns undefined if the resource hasn't been inserted. */
    resource<D>(factory: ResourceFactory<D> | ComponentFactory<D>): D | undefined;
    /** Remove a world resource. No-op if it doesn't exist. */
    removeResource<D>(factory: ResourceFactory<D> | ComponentFactory<D>): void;
    /** Check whether a world resource has been inserted. */
    hasResource<D>(factory: ResourceFactory<D> | ComponentFactory<D>): boolean;
    /**
     * Check whether a resource changed since the last time this observer (system) checked.
     * Uses the Engine-set `_currentObserver` for automatic per-system tick tracking.
     *
     * ```ts
     * // In any system.update():
     * if (!world.resourceChanged(DataStore)) return; // skip work if unchanged
     * ```
     */
    resourceChanged<D>(factory: ResourceFactory<D>): boolean;
    /**
     * Manually bump a resource's changedTick without changing its data.
     * Needed when the resource data is mutated in-place (e.g. Map.set()) without going through setComponent.
     */
    markResourceChanged<D>(factory: ResourceFactory<D>): void;
    addComponent(entity: Entity, component: Component): void;
    setComponent(entity: Entity, component: Component): void;
    patchComponent<Data>(entity: Entity, factory: ComponentFactory<Data>, patch: Partial<Data>): void;
    /**
     * 批量写组件（Story P0-04）：对多实体应用同 patch（或 per-entity patch 数组），
     * 按 archetype 分组列级直写——Float64Column 数值字段 TypedArray 直写（零装箱）。
     * 语义与逐实体 setComponent 一致（同 tick、触发 Changed）。跳过无此组件的实体。
     * @returns 实际写入的实体数
     */
    setComponents<Data>(factory: ComponentFactory<Data>, entities: readonly Entity[], patch: Partial<Data> | readonly Partial<Data>[]): number;
    /** Read a component. O(1): entity_index → archetype + row → component_index → column[row].
     *  Mertens: two map lookups + one array access. */
    getComponent<Data>(entity: Entity, factory: ComponentFactory<Data>): Data | undefined;
    /** Read a component entry with its ticks. */
    getComponentEntry<Data>(entity: Entity, factory: ComponentFactory<Data>): {
        data: Data;
        addedTick: number;
        changedTick: number;
    } | undefined;
    /** Check whether an entity has a component of the given factory's kind. */
    hasComponent(entity: Entity, factory: ComponentFactory<unknown>): boolean;
    /** Remove a component from an entity. */
    removeComponent(entity: Entity, factory: ComponentFactory<unknown>): void;
    query: <const F extends readonly ComponentFactory<unknown>[]>(this: World, ...factories: F) => Query<F>;
    /** Mutation-safe query facade using a per-call snapshot. */
    queryMut: <const F extends readonly ComponentFactory<unknown>[]>(this: World, ...factories: F) => Query<F>;
    /** Return explicit removeComponent events unseen by the current observer.
     * Entity destruction is reported separately by drainKilled(). */
    removed: <D>(factory: ComponentFactory<D>) => Entity[];
    /**
     * Create independent Changed/Added cursors for a persistent query reader.
     * QueryState is caller-owned; call forget()/clear() when retiring a long-lived
     * reader, or use a query whose state lifetime matches the reader.
     */
    createQueryState(): QueryState;
    constructor();
    /**
     * 帧末轮转移除事件双缓冲（Bevy RemovedComponents 事件存活 2 帧）。
     *
     * 与 `drainKilled()` 同一套语义：**帧内排序无关**——排在移除者之后的系统本帧看到，
     * 排在前面的系统下帧仍能看到。每 kind 独立平移游标：
     * `new = clamp(old − 被淘汰帧长, 0, 新窗口长)`。数组换位复用（零分配）。
     */
    _rotateRemoved(): void;
    /** @internal Enqueue a deferred command closure. Used by Commands class. */
    _enqueue(fn: () => void): void;
    /** Apply all pending commands (structural mutations). No-op when there are no
     *  deferred commands — the engine calls this after each system for safety. */
    applyCommands(): void;
    flushDestroyed(): void;
    get hasKilledEntities(): boolean;
    /** Highest tick at which component `kind` was changed. For dirty-check fast path. */
    lastChangedTick(kind: string): number;
    /**
     * Killed entities unseen by THIS observer (system). Bevy RemovedComponents 等价——
     * 多读者：每个 observer 独立游标，都看到全部未消费 kill（不再单消费者）。
     * 双缓冲：kill 事件保留 2 帧（与 Bevy 事件双缓冲一致），因此系统与 killer 的
     * 帧内先后顺序不影响可见性；帧末 setCurrentObserver(null) 轮转缓冲区。
     */
    drainKilled(): Entity[];
    get tick(): number;
    setCurrentObserver(name: string | null): void;
    isAnyDirty(kinds: string[], sinceTick: number): boolean;
    dumpEcs(): {
        entityCount: number;
        entities: Array<{
            eid: number;
            archetype: string[];
            components: string[];
            data: Record<string, unknown>;
        }>;
    };
    /** Registered component kinds (insertion order) — entity introspection (Bevy archetype/components 等价). */
    kinds(): string[];
    /** Raw component data for an entity+kind (shallow copy — value-type introspection). */
    componentData(entity: Entity, kind: string): Record<string, unknown> | undefined;
    private _nextTick;
    /** Find or create an archetype for a sorted set of component kinds.
     *  Phase 2: kinds with a registered schema get Float64Column, others ObjectColumn. */
    private _findOrCreateArchetype;
    /** @internal Get raw component data (no isAlive check, no type safety). Used by Commands. */
    _getComponentRaw(entity: Entity, kind: string): Record<string, unknown> | undefined;
    private _getComponentEntryRaw;
    /** O(1) — checks component_index for the archetype. */
    private _hasComponentInternal;
    /** Write a component to an entity — handles both insert (new kind) and update (existing kind). */
    private _writeComponent;
    /** Remove a component kind from an entity — moves to new archetype without that kind. */
    private _deleteComponent;
    /** Swap-and-pop entity from its archetype. Updates moved entity's row. */
    private _removeEntityFromArchetype;
    /** Batch cleanup of deferred destroys. */
    private _flushDestroys;
    /** Record one same-frame removal per entity/kind and advance the dirty tick. */
    private trackRemoval;
    /** Fire all hooks in a set for an entity. No-op if hooks is undefined/empty. */
    private _fireHooks;
    private _getLastSeenAdded;
    private _getLastSeenChanged;
    private _setLastSeenAdded;
    private _setLastSeenChanged;
}
//# sourceMappingURL=world.d.ts.map