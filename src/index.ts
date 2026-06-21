// packages/ecs/src/index.ts — Entity-Component-System core
// Zero dependencies. Pure TypeScript.
//
// ## Design (api-design principles)
// - 渐进式增强：spawn/destroy/addComponent 三行入门，query/patchComponent 精细控制
// - 类型即文档：ComponentKind 联合类型驱动自动补全，ComponentOf<K>/DataOf<K> 泛型工具
// - 原子化：每个方法做且只做一件事。组合 spawn + addComponent + query 实现任意需求
// - 框架无关：System 是纯 TS 接口
//
// ## Extensibility
// ComponentSchemas is an interface — users can augment it via declaration merging:
//   declare module '@learnvis/ecs' { interface ComponentSchemas { physics: { ... } } }

/** 3D vector tuple. */
export type Vec3 = [number, number, number];

// ═══════════════════════════════════════════════════════════
// Entity
// ═══════════════════════════════════════════════════════════

declare const EntityBrand: unique symbol;
/** Opaque entity handle — branded number, constructable only via World.spawn(). */
export type Entity = number & { [EntityBrand]: true };

let _nextRawId = 1;
function _createEntity(): Entity {
  return _nextRawId++ as number as Entity;
}

// ═══════════════════════════════════════════════════════════
// Component type system
// ═══════════════════════════════════════════════════════════

export type GeometryKind =
  // 3D
  | "arrow"
  | "sphere"
  | "cube"
  | "sprite"
  | "grid"
  | "axes"
  | "line"
  | "surface"
  | "fill"
  | "arc"
  | "rightAngle"
  | "vectors"
  // 2D
  | "point2d"
  | "circle2d"
  | "rect2d"
  | "polygon2d"
  | "curve2d"
  | "angle2d"
  | "line2d"
  | "axes2d"
  | "grid2d"
  | "vector2d";

/** Material role — each primitive declares how its materials should be treated. */
export type MaterialRoleKind = "structural" | "fill";
// structural: wireframe/edges/outlines — user .opacity() controls
// fill:       faces/fans/fills — fixed opacity defined at spawn (recipe)

// ═══════════════════════════════════════════════════════════
// System access declaration (documentation)
// ═══════════════════════════════════════════════════════════

/**
 * System access declaration — documents what a system reads, writes,
 * and what external side effects it produces.
 *
 * No runtime enforcement. Material capability table (getMaterialCaps)
 * protects against the one class of bug this would catch.
 */
export interface SystemAccess {
  readonly reads?: readonly ComponentKind[];
  readonly writes?: readonly ComponentKind[];
  readonly sideEffects?: readonly string[];
}

/**
 * Component kind — string union.
 * Each member maps to a data shape in ComponentSchemas.
 * Used as discriminant in the Component union type.
 */
export type ComponentKind =
  | "position3D"
  | "position2D"
  | "geometry"
  | "appearance"
  | "label"
  | "thickness"
  | "size"
  | "userId"
  | "materialRole"
  | "batchGroup"
  | "transform2D"
  | "animationPhase"
  | "opacity"
  | "scale"
  | "disposing";

/**
 * Component data schemas — one entry per ComponentKind.
 * Declared as interface so users can augment via declaration merging.
 *
 * ```ts
 * declare module 'vis3d/ecs' {
 *   interface ComponentSchemas {
 *     velocity: { vx: number; vy: number; vz: number };
 *   }
 * }
 * ```
 */
/** 2D transform operation. */
export interface Transform2dOp {
  type: "rotate" | "scale" | "translate" | "matrix";
  // rotate: angle (deg), about center (cx, cy)
  angle?: number;
  cx?: number;
  cy?: number;
  // scale
  sx?: number;
  sy?: number;
  // translate
  dx?: number;
  dy?: number;
  // matrix: 2×2 linear + translation
  a?: number;
  b?: number;
  c?: number;
  d?: number;
  tx?: number;
  ty?: number;
}

export interface ComponentSchemas {
  position3D: { x: number; y: number; z: number };
  position2D: { x: number; y: number };
  geometry: { kind: GeometryKind } & Record<string, unknown>;
  appearance: { color: number; opacity: number; wireframe: boolean; emissive: number };
  label: { text: string; offset: Vec3 };
  thickness: { value: number };
  size: { value: number };
  userId: { value: string };
  materialRole: { kind: MaterialRoleKind; opacity: number };
  batchGroup: { value: string };
  transform2D: { ops: Transform2dOp[] };
  animationPhase: { phase: "entering" | "done" | "exiting"; startMs: number };
  opacity: { value: number };
  scale: { value: number };
  disposing: { timestamp: number };
}

/**
 * Full discriminated-union component type.
 * Component = { type: 'position3D'; x; y; z } | { type: 'geometry'; kind; ... } | ...
 */
export type Component = {
  [K in ComponentKind]: { type: K } & ComponentSchemas[K];
}[ComponentKind];

/** Extract the specific component shape for a given kind. */
export type ComponentOf<K extends ComponentKind> = Extract<Component, { type: K }>;

/** Extract the data payload (without the `type` discriminant) for a given kind. */
export type DataOf<K extends ComponentKind> = ComponentSchemas[K];

// ═══════════════════════════════════════════════════════════
// System interface
// ═══════════════════════════════════════════════════════════

/**
 * A System reads components from the World and produces side effects.
 *
 * ```ts
 * const mySystem: System = {
 *   name: 'physics',
 *   access: { reads: ['position3D'] },
 *   update(world, context) { ... },
 * };
 * ```
 */
export interface System {
  readonly name: string;
  readonly access: SystemAccess;
  /** Called once after all systems are registered and topo-sorted. */
  setup?(world: World, context: unknown): void;
  /** Called every frame by World.update(). */
  update(world: World, context: unknown): void;
}

// ═══════════════════════════════════════════════════════════
// World
// ═══════════════════════════════════════════════════════════

/** Default data values used by patchComponent when a component doesn't exist yet. */
const DEFAULTS: { [K in ComponentKind]: DataOf<K> } = {
  position3D: { x: 0, y: 0, z: 0 },
  position2D: { x: 0, y: 0 },
  geometry: { kind: "sprite" as GeometryKind },
  appearance: { color: 0xe06b38, opacity: 1, wireframe: false, emissive: 0 },
  label: { text: "", offset: [0, 0.7, 0] },
  thickness: { value: 0.015 },
  size: { value: 8 },
  userId: { value: "" },
  materialRole: { kind: "structural" as MaterialRoleKind, opacity: 1 },
  batchGroup: { value: "" },
  transform2D: { ops: [] },
  animationPhase: { phase: "entering", startMs: 0 },
  opacity: { value: 1 },
  scale: { value: 1 },
  disposing: { timestamp: 0 },
};

type CompEntry = { data: Component; addedTick: number; changedTick: number };

export class World {
  private tickCounter = 0;
  private stores = new Map<ComponentKind, Map<Entity, CompEntry>>();
  private alive = new Set<Entity>();
  private userIdIndex = new Map<string, Entity>();
  private systems: System[] = [];
  private deferredDestroys: Entity[] = [];
  private currentObserver: string | null = null;
  // Per-observer per-entity per-kind last-seen ticks (added / changed)
  private seenAdded = new Map<string, Map<Entity, Map<string, number>>>();
  private seenChanged = new Map<string, Map<Entity, Map<string, number>>>();

  /**
   * On-demand state dump — returns all entities, components, and system declarations.
   * Zero per-frame cost. Call when debugging.
   */
  dump(): {
    entityCount: number;
    entities: Array<{
      eid: number;
      userId?: string;
      components: string[];
      data: Record<string, unknown>;
    }>;
    systems: Array<{ name: string; reads: string[]; writes: string[]; sideEffects: string[] }>;
  } {
    const ALL_KINDS: ComponentKind[] = [
      "position3D",
      "position2D",
      "geometry",
      "appearance",
      "label",
      "thickness",
      "size",
      "userId",
      "materialRole",
      "opacity",
      "scale",
      "batchGroup",
      "transform2D",
      "animationPhase",
      "disposing",
    ];

    // Entities: iterate all component stores
    const eMap = new Map<
      Entity,
      { userId?: string; comps: Set<string>; data: Record<string, unknown> }
    >();
    for (const kind of ALL_KINDS) {
      const store = this.stores.get(kind);
      if (!store) continue;
      for (const [e, entry] of store) {
        if (!this.alive.has(e)) continue;
        let item = eMap.get(e);
        if (!item) {
          item = { comps: new Set(), data: {} };
          eMap.set(e, item);
        }
        item.comps.add(kind);
        const { type, ...rest } = entry.data as Record<string, unknown>;
        item.data[kind] = rest;
      }
    }
    // Resolve userId
    const userIdStore = this.stores.get("userId");
    for (const [e, entry] of eMap) {
      if (userIdStore) {
        const uid = userIdStore.get(e);
        if (uid) entry.userId = (uid.data as Record<string, string>).value;
      }
    }
    const entities = [...eMap.entries()]
      .sort(([a], [b]) => a - b)
      .map(([eid, entry]) => ({
        eid,
        userId: entry.userId,
        components: [...entry.comps].sort(),
        data: entry.data,
      }));

    // Systems
    const systems = this.systems.map((s) => ({
      name: s.name,
      reads: s.access.reads ? [...s.access.reads] : [],
      writes: s.access.writes ? [...s.access.writes] : [],
      sideEffects: s.access.sideEffects ? [...s.access.sideEffects] : [],
    }));

    return { entityCount: this.alive.size, entities, systems };
  }

  // ══ Entity lifecycle ══

  /**
   * Create an entity. With no args, creates empty.
   * With components, applies each. overrides are keyed by ComponentKind.
   *   world.spawn(Point3D, { position3D: {x, y, z}, userId: {value: id} })
   */
  spawn(components?: Component[], overrides?: Partial<Record<ComponentKind, object>>): Entity {
    const entity = _createEntity();
    this.alive.add(entity);
    if (components) {
      for (const c of components) {
        const patch = overrides?.[c.type] as object | undefined;
        this.addComponent(entity, (patch ? { ...c, ...patch } : c) as Component);
      }
    }
    return entity;
  }

  /** Mark an entity as destroyed. Components are deferred to end of World.update(). */
  destroy(entity: Entity): void {
    if (!this.alive.has(entity)) return;
    this.alive.delete(entity);
    this.deferredDestroys.push(entity);
  }

  private flushDestroys(): void {
    if (this.deferredDestroys.length === 0) return;
    const userIdStore = this.stores.get("userId");
    for (const entity of this.deferredDestroys) {
      if (userIdStore) {
        const c = userIdStore.get(entity);
        if (c) {
          const userId = (c.data as ComponentOf<"userId">).value;
          if (this.userIdIndex.get(userId) === entity) {
            this.userIdIndex.delete(userId);
          }
        }
      }
      for (const store of this.stores.values()) {
        store.delete(entity);
      }
    }
    this.deferredDestroys.length = 0;
  }

  /** Returns true if the entity is still alive. */
  isAlive(entity: Entity): boolean {
    return this.alive.has(entity);
  }

  /** Total number of alive entities. */
  entityCount(): number {
    return this.alive.size;
  }

  /** Was this component added since the observer last ran? */
  didAdd(entity: Entity, kind: ComponentKind): boolean {
    if (!this.alive.has(entity)) return false;
    const entry = this.stores.get(kind)?.get(entity);
    if (!entry) return false;
    const lastSeen = this.getLastSeenAdded(this.currentObserver, entity, kind);
    return entry.addedTick > lastSeen;
  }

  /** Was this component written since the observer last saw it? */
  didChange(entity: Entity, kind: ComponentKind): boolean {
    if (!this.alive.has(entity)) return false;
    const entry = this.stores.get(kind)?.get(entity);
    if (!entry) return false;
    const lastSeen = this.getLastSeenChanged(this.currentObserver, entity, kind);
    return entry.changedTick > lastSeen;
  }

  // ══ Component operations ══

  /**
   * Attach a component to an entity.
   * Throws if the entity already has a component of this kind — use setComponent for upsert.
   */
  addComponent<K extends ComponentKind>(entity: Entity, component: ComponentOf<K>): void {
    if (!this.alive.has(entity)) return;
    const tick = ++this.tickCounter;
    let store = this.stores.get(component.type);
    if (!store) {
      store = new Map();
      this.stores.set(component.type, store);
    }
    if (store.has(entity)) {
      throw new Error(
        `Entity ${entity} already has component '${component.type}'. Use setComponent() to replace.`,
      );
    }
    store.set(entity, { data: component as Component, addedTick: tick, changedTick: tick });
    if (component.type === "userId") {
      const c = component as ComponentOf<"userId">;
      this.userIdIndex.set(c.value, entity);
    }
  }

  /** Attach or replace a component on an entity. */
  setComponent<K extends ComponentKind>(entity: Entity, component: ComponentOf<K>): void {
    if (!this.alive.has(entity)) return;
    const changedTick = ++this.tickCounter;
    let store = this.stores.get(component.type);
    if (!store) {
      store = new Map();
      this.stores.set(component.type, store);
    }
    const old = store.get(entity);
    if (component.type === "userId") {
      if (old) this.userIdIndex.delete((old.data as ComponentOf<"userId">).value);
    }
    const addedTick = old ? old.addedTick : changedTick;
    store.set(entity, { data: component as Component, addedTick, changedTick });
    if (component.type === "userId") {
      const c = component as ComponentOf<"userId">;
      this.userIdIndex.set(c.value, entity);
    }
  }

  /**
   * Partial update: reads existing component, merges `patch`, writes back.
   * If the component doesn't exist yet, it's created from defaults + patch.
   * This is the primary API for Gfx3dImpl chain methods.
   */
  patchComponent<K extends ComponentKind>(
    entity: Entity,
    kind: K,
    patch: Partial<DataOf<K>>,
  ): void {
    if (!this.alive.has(entity)) return;
    const existing = this.getComponent(entity, kind);
    if (existing) {
      const merged = { ...existing, ...patch };
      this.setComponent(entity, merged as unknown as ComponentOf<K>);
    } else {
      const defaults = DEFAULTS[kind] as DataOf<K>;
      const merged = { ...defaults, ...patch };
      this.setComponent(entity, { type: kind, ...merged } as unknown as ComponentOf<K>);
    }
  }

  /** Get a component by kind. Returns undefined if absent or entity is dead. */
  getComponent<K extends ComponentKind>(entity: Entity, kind: K): ComponentOf<K> | undefined {
    if (!this.alive.has(entity)) return undefined;
    const store = this.stores.get(kind);
    if (!store) return undefined;
    return store.get(entity)?.data as ComponentOf<K> | undefined;
  }

  /** Read a component entry with its ticks. Escape hatch for systems that need tick info directly. */
  getComponentEntry<K extends ComponentKind>(
    entity: Entity,
    kind: K,
  ): { data: ComponentOf<K>; addedTick: number; changedTick: number } | undefined {
    if (!this.alive.has(entity)) return undefined;
    const store = this.stores.get(kind);
    if (!store) return undefined;
    const entry = store.get(entity);
    if (!entry) return undefined;
    return {
      data: entry.data as ComponentOf<K>,
      addedTick: entry.addedTick,
      changedTick: entry.changedTick,
    };
  }

  /** Check whether an entity has a component of the given kind. */
  hasComponent(entity: Entity, kind: ComponentKind): boolean {
    if (!this.alive.has(entity)) return false;
    const store = this.stores.get(kind);
    return store ? store.has(entity) : false;
  }

  /** Remove a component from an entity. */
  removeComponent(entity: Entity, kind: ComponentKind): void {
    if (!this.alive.has(entity)) return;
    const store = this.stores.get(kind);
    if (!store) return;
    // Clean up userId index
    if (kind === "userId") {
      const old = store.get(entity);
      if (old) this.userIdIndex.delete((old.data as ComponentOf<"userId">).value);
    }
    store.delete(entity);
  }

  // ══ Query ══

  /** Query API — two orthogonal dimensions: scope × operator. */
  query = {
    /** All entities that have ALL specified kinds (AND, full scan). */
    all: (...kinds: ComponentKind[]): Generator<Entity> => {
      if (kinds.length === 0) return (function* () {})();
      const first = this.stores.get(kinds[0]!);
      if (!first) return (function* () {})();
      return (function* (self: World) {
        for (const e of first!.keys()) {
          if (!self.alive.has(e)) continue;
          if (kinds.length === 1) {
            yield e;
            continue;
          }
          let hasAll = true;
          for (let i = 1; i < kinds.length; i++) {
            const s = self.stores.get(kinds[i]!);
            if (!s || !s.has(e)) {
              hasAll = false;
              break;
            }
          }
          if (hasAll) yield e;
        }
      })(this);
    },

    /** All entities that have at least one of the specified kinds (OR, full scan). */
    any: (...kinds: ComponentKind[]): Generator<Entity> => {
      if (kinds.length === 0) return (function* () {})();
      return (function* (self: World) {
        const seen = new Set<Entity>();
        for (const kind of kinds) {
          const store = self.stores.get(kind);
          if (!store) continue;
          for (const e of store.keys()) {
            if (!self.alive.has(e) || seen.has(e)) continue;
            seen.add(e);
            yield e;
          }
        }
      })(this);
    },

    /** All entities that have `kind` but NOT `without` (full scan). */
    except: (kind: ComponentKind, without: ComponentKind): Generator<Entity> => {
      const store = this.stores.get(kind);
      if (!store) return (function* () {})();
      const excluded = this.stores.get(without);
      return (function* (self: World) {
        for (const e of store!.keys()) {
          if (!self.alive.has(e)) continue;
          if (excluded?.has(e)) continue;
          yield e;
        }
      })(this);
    },

    /** Entities whose component was ADDED since last seen. */
    added: (kind: ComponentKind): Generator<Entity> => {
      const store = this.stores.get(kind);
      if (!store) return (function* () {})();
      const obs = this.currentObserver;
      return (function* (self: World) {
        for (const [e, entry] of store!) {
          if (!self.alive.has(e)) continue;
          const lastSeen = self.getLastSeenAdded(obs, e, kind);
          if (entry.addedTick <= lastSeen) continue;
          self.setLastSeenAdded(obs, e, kind, entry.addedTick);
          yield e;
        }
      })(this);
    },

    /** Entities where changedTick advanced since last seen (AND). */
    changed: (...kinds: ComponentKind[]): Generator<Entity> => {
      if (kinds.length === 0) return (function* () {})();
      const obs = this.currentObserver;
      const store = this.stores.get(kinds[0]!);
      if (!store) return (function* () {})();
      return (function* (self: World) {
        for (const [e, entry] of store!) {
          if (!self.alive.has(e)) continue;
          if (kinds.length > 1) {
            let hasAll = true;
            for (let i = 1; i < kinds.length; i++) {
              const s = self.stores.get(kinds[i]!);
              if (!s || !s.has(e)) {
                hasAll = false;
                break;
              }
            }
            if (!hasAll) continue;
          }
          let changed = false;
          for (const k of kinds) {
            const lastSeen = self.getLastSeenChanged(obs, e, k);
            const ct = self.stores.get(k)?.get(e)?.changedTick ?? 0;
            if (ct > lastSeen) {
              changed = true;
              self.setLastSeenChanged(obs, e, k, ct);
            }
          }
          if (changed) yield e;
        }
      })(this);
    },

    /** Entities where ANY specified kind's changedTick advanced (OR). */
    changedAny: (...kinds: ComponentKind[]): Generator<Entity> => {
      if (kinds.length === 0) return (function* () {})();
      const obs = this.currentObserver;
      return (function* (self: World) {
        const yielded = new Set<Entity>();
        for (const kind of kinds) {
          const store = self.stores.get(kind);
          if (!store) continue;
          for (const [e, entry] of store) {
            if (!self.alive.has(e)) continue;
            const lastSeen = self.getLastSeenChanged(obs, e, kind);
            if (entry.changedTick <= lastSeen) continue;
            self.setLastSeenChanged(obs, e, kind, entry.changedTick);
            if (!yielded.has(e)) {
              yielded.add(e);
              yield e;
            }
          }
        }
      })(this);
    },
  };

  private getLastSeenAdded(observer: string | null, entity: Entity, kind: string): number {
    const key: string = observer ?? "__direct__";
    return this.seenAdded.get(key)?.get(entity)?.get(kind) ?? 0;
  }
  private getLastSeenChanged(observer: string | null, entity: Entity, kind: string): number {
    const key: string = observer ?? "__direct__";
    return this.seenChanged.get(key)?.get(entity)?.get(kind) ?? 0;
  }

  private setLastSeenAdded(
    observer: string | null,
    entity: Entity,
    kind: string,
    tick: number,
  ): void {
    const key: string = observer ?? "__direct__";
    let obs = this.seenAdded.get(key);
    if (!obs) {
      obs = new Map();
      this.seenAdded.set(key, obs);
    }
    let ent = obs.get(entity);
    if (!ent) {
      ent = new Map();
      obs.set(entity, ent);
    }
    ent.set(kind, tick);
  }
  private setLastSeenChanged(
    observer: string | null,
    entity: Entity,
    kind: string,
    tick: number,
  ): void {
    const key: string = observer ?? "__direct__";
    let obs = this.seenChanged.get(key);
    if (!obs) {
      obs = new Map();
      this.seenChanged.set(key, obs);
    }
    let ent = obs.get(entity);
    if (!ent) {
      ent = new Map();
      obs.set(entity, ent);
    }
    ent.set(kind, tick);
  }

  // ══ User ID index ══

  /** Find an entity by its userId component value. Returns undefined if dead. */
  entityByUserId(id: string): Entity | undefined {
    const e = this.userIdIndex.get(id);
    return e !== undefined && this.alive.has(e) ? e : undefined;
  }

  // ══ System management ══

  private systemBuilders: SystemBuilder[] = [];
  private built = false;

  /** Register a system. Returns a builder for explicit ordering. Call build() after initial registration. */
  addSystem(system: System): SystemBuilder {
    if (this.built) {
      // Late registration — append to execution order
      this.systems.push(system);
      return new SystemBuilder(system);
    }
    const builder = new SystemBuilder(system);
    this.systemBuilders.push(builder);
    return builder;
  }

  /** Auto-topo-sort from access declarations + explicit overrides. Call once after all addSystem(). */
  build(): void {
    if (this.built) return;

    // Resolve system names
    const nameMap = new Map<string, System>();
    const builderMap = new Map<System, SystemBuilder>();
    for (const b of this.systemBuilders) {
      nameMap.set(b.system.name, b.system);
      builderMap.set(b.system, b);
    }

    // ── Auto-derive edges from access declarations ──
    // Write-before-read: A writes X, B reads X → A → B
    const edges = new Map<System, Set<System>>(); // sys → its predecessors (must run before it)

    for (const b of this.systemBuilders) {
      edges.set(b.system, new Set());
    }

    for (const a of this.systemBuilders) {
      const writes = a.system.access.writes ?? [];
      if (writes.length === 0) continue;
      for (const b of this.systemBuilders) {
        if (a === b) continue;
        const reads = b.system.access.reads ?? [];
        for (const kind of writes) {
          if (reads.includes(kind)) {
            // A writes X, B reads X → A must run before B
            edges.get(b.system)!.add(a.system);
          }
        }
      }
    }

    // ── Apply explicit overrides ──
    for (const b of this.systemBuilders) {
      for (const beforeName of b.runsAfter) {
        const pred = nameMap.get(beforeName);
        if (pred) edges.get(b.system)!.add(pred);
      }
      for (const afterName of b.runsBefore) {
        const succ = nameMap.get(afterName);
        if (succ) edges.get(succ)!.add(b.system);
      }
    }

    // ── Topological sort (Kahn's algorithm) ──
    const inDegree = new Map<System, number>();
    const successors = new Map<System, Set<System>>();
    for (const s of edges.keys()) {
      inDegree.set(s, 0);
      successors.set(s, new Set());
    }
    for (const [sys, preds] of edges) {
      inDegree.set(sys, preds.size);
      for (const pred of preds) {
        successors.get(pred)!.add(sys);
      }
    }

    const queue: System[] = [];
    for (const [sys, deg] of inDegree) {
      if (deg === 0) queue.push(sys);
    }

    const sorted: System[] = [];
    while (queue.length > 0) {
      const sys = queue.shift()!;
      sorted.push(sys);
      for (const succ of successors.get(sys)!) {
        const newDeg = inDegree.get(succ)! - 1;
        inDegree.set(succ, newDeg);
        if (newDeg === 0) queue.push(succ);
      }
    }

    // Cycle detection
    if (sorted.length !== edges.size) {
      const remaining = [...edges.keys()].filter((s) => !sorted.includes(s));
      throw new Error(
        `[ECS] Circular dependency detected involving: ${remaining.map((s) => s.name).join(", ")}. ` +
          `Check .before() / .after() chains or write/read declarations.`,
      );
    }

    this.systems = sorted;
    this.built = true;
  }

  /** Call setup() on every system that defines it. Pass `context` from caller. */
  setup(context: unknown): void {
    if (!this.built) this.build();
    for (const sys of this.systems) sys.setup?.(this, context);
  }

  getSystems(): readonly System[] {
    return this.systems;
  }

  update(context: unknown): void {
    if (!this.built) this.build();
    for (const sys of this.systems) {
      this.currentObserver = sys.name;
      sys.update(this, context);
    }
    this.currentObserver = null;
    this.flushDestroys();
  }
}

/** Chainable builder for explicit ordering constraints. */
class SystemBuilder {
  readonly system: System;
  runsAfter: string[] = [];
  runsBefore: string[] = [];

  constructor(system: System) {
    this.system = system;
  }

  /** This system runs after the named system. */
  after(name: string): this {
    this.runsAfter.push(name);
    return this;
  }
  /** This system runs before the named system. */
  before(name: string): this {
    this.runsBefore.push(name);
    return this;
  }
}
