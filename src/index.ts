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
  return (_nextRawId++ as number) as Entity;
}

// ═══════════════════════════════════════════════════════════
// Component type system
// ═══════════════════════════════════════════════════════════

export type GeometryKind = 'arrow' | 'sphere' | 'cube' | 'sprite' | 'grid' | 'axes' | 'line' | 'surface' | 'fill' | 'arc' | 'rightAngle';

/** Material role — each primitive declares how its materials should be treated. */
export type MaterialRoleKind = 'structural' | 'fill';
// structural: wireframe/edges/outlines — user .opacity() controls
// fill:       faces/fans/fills — fixed opacity defined at spawn (recipe)

/**
 * Component kind — string union.
 * Each member maps to a data shape in ComponentSchemas.
 * Used as discriminant in the Component union type.
 */
export type ComponentKind =
  | 'position3'
  | 'geometry'
  | 'appearance'
  | 'label'
  | 'thickness'
  | 'size'
  | 'userId'
  | 'materialRole'
  | 'opacityOverride';

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
export interface ComponentSchemas {
  position3:  { x: number; y: number; z: number };
  geometry:   { kind: GeometryKind } & Record<string, unknown>;
  appearance: { color: number; opacity: number; wireframe: boolean; emissive: number };
  label:      { text: string; offset: Vec3 };
  thickness:  { value: number };
  size:       { value: number };
  userId:     { value: string };
  materialRole:  { kind: MaterialRoleKind; opacity: number };
  opacityOverride: { value: number };
}

/**
 * Full discriminated-union component type.
 * Component = { type: 'position3'; x; y; z } | { type: 'geometry'; kind; ... } | ...
 */
export type Component = {
  [K in ComponentKind]: { type: K } & ComponentSchemas[K]
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
 *   requiredComponents: ['position3'],
 *   update(world, context) { ... },
 * };
 * ```
 */
export interface System {
  /** Human-readable name (for debugging / devtools). */
  readonly name: string;
  /** Component kinds this system depends on (for future tooling). */
  readonly requiredComponents: readonly ComponentKind[];
  /**
   * Called every frame by World.update().
   * @param world  The ECS world (read/write components, query entities).
   * @param context  Opaque context passed through from World.update(context).
   */
  update(world: World, context: unknown): void;
}

// ═══════════════════════════════════════════════════════════
// World
// ═══════════════════════════════════════════════════════════

/** Default data values used by patchComponent when a component doesn't exist yet. */
const DEFAULTS: { [K in ComponentKind]: DataOf<K> } = {
  position3:  { x: 0, y: 0, z: 0 },
  geometry:   { kind: 'sprite' as GeometryKind },
  appearance: { color: 0xe06b38, opacity: 1, wireframe: false, emissive: 0 },
  label:      { text: '', offset: [0, 0.7, 0] },
  thickness:  { value: 0.06 },
  size:       { value: 8 },
  userId:     { value: '' },
  materialRole:  { kind: 'structural' as MaterialRoleKind, opacity: 1 },
  opacityOverride: { value: 1 },
};

export class World {
  // Per-kind sparse sets: ComponentKind → Map<Entity, Component>
  private _stores = new Map<ComponentKind, Map<Entity, Component>>();
  private _alive = new Set<Entity>();
  private _userIdIndex = new Map<string, Entity>();
  private _systems: System[] = [];

  // ══ Entity lifecycle ══

  /** Create a new empty entity. Returns opaque handle. */
  spawn(): Entity {
    const entity = _createEntity();
    this._alive.add(entity);
    return entity;
  }

  /** Mark an entity as destroyed. Its components are cleaned up on next World.update(). */
  destroy(entity: Entity): void {
    if (!this._alive.has(entity)) return;
    this._alive.delete(entity);
    // Remove userId index
    const userIdStore = this._stores.get('userId');
    const userIdComp = userIdStore?.get(entity);
    if (userIdComp) {
      this._userIdIndex.delete((userIdComp as ComponentOf<'userId'>).value);
    }
    // Remove all components
    for (const store of this._stores.values()) {
      store.delete(entity);
    }
  }

  /** Returns true if the entity is still alive. */
  isAlive(entity: Entity): boolean {
    return this._alive.has(entity);
  }

  // ══ Component operations ══

  /**
   * Attach a component to an entity.
   * Throws if the entity already has a component of this kind — use setComponent for upsert.
   */
  addComponent<K extends ComponentKind>(entity: Entity, component: ComponentOf<K>): void {
    if (!this._alive.has(entity)) return;
    let store = this._stores.get(component.type);
    if (!store) {
      store = new Map();
      this._stores.set(component.type, store);
    }
    if (store.has(entity)) {
      throw new Error(
        `Entity ${entity} already has component '${component.type}'. Use setComponent() to replace.`
      );
    }
    store.set(entity, component as Component);
    // Index userId
    if (component.type === 'userId') {
      const c = component as ComponentOf<'userId'>;
      this._userIdIndex.set(c.value, entity);
    }
  }

  /** Attach or replace a component on an entity. */
  setComponent<K extends ComponentKind>(entity: Entity, component: ComponentOf<K>): void {
    if (!this._alive.has(entity)) return;
    let store = this._stores.get(component.type);
    if (!store) {
      store = new Map();
      this._stores.set(component.type, store);
    }
    // Clean up old userId index entry before overwriting
    if (component.type === 'userId') {
      const old = store.get(entity);
      if (old) this._userIdIndex.delete((old as ComponentOf<'userId'>).value);
    }
    store.set(entity, component as Component);
    // Index new userId
    if (component.type === 'userId') {
      const c = component as ComponentOf<'userId'>;
      this._userIdIndex.set(c.value, entity);
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
    if (!this._alive.has(entity)) return;
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

  /** Get a component by kind. Returns undefined if absent. */
  getComponent<K extends ComponentKind>(
    entity: Entity,
    kind: K,
  ): ComponentOf<K> | undefined {
    const store = this._stores.get(kind);
    if (!store) return undefined;
    return store.get(entity) as ComponentOf<K> | undefined;
  }

  /** Check whether an entity has a component of the given kind. */
  hasComponent(entity: Entity, kind: ComponentKind): boolean {
    const store = this._stores.get(kind);
    return store ? store.has(entity) : false;
  }

  /** Remove a component from an entity. */
  removeComponent(entity: Entity, kind: ComponentKind): void {
    const store = this._stores.get(kind);
    if (!store) return;
    // Clean up userId index
    if (kind === 'userId') {
      const old = store.get(entity);
      if (old) this._userIdIndex.delete((old as ComponentOf<'userId'>).value);
    }
    store.delete(entity);
  }

  // ══ Query ══

  /**
   * Find all entities that have ALL the specified component kinds.
   * Returns an empty array if any kind has no store.
   */
  query(...kinds: ComponentKind[]): Entity[] {
    if (kinds.length === 0) return [];
    const first = this._stores.get(kinds[0]!);
    if (!first || first.size === 0) return [];
    // Start with entities that have the first kind
    const candidates = [...first.keys()].filter(e => this._alive.has(e));
    if (kinds.length === 1) return candidates;
    // Filter by remaining kinds
    return candidates.filter(e => {
      for (let i = 1; i < kinds.length; i++) {
        const store = this._stores.get(kinds[i]!);
        if (!store || !store.has(e)) return false;
      }
      return true;
    });
  }

  // ══ User ID index ══

  /** Find an entity by its userId component value. */
  entityByUserId(id: string): Entity | undefined {
    return this._userIdIndex.get(id);
  }

  // ══ System management ══

  /** Register a system. Systems run in registration order on each World.update() call. */
  addSystem(system: System): void {
    this._systems.push(system);
  }

  /**
   * Run all registered systems in order.
   * @param context  Passed through to every System.update() call.
   */
  update(context: unknown): void {
    for (const sys of this._systems) {
      sys.update(this, context);
    }
  }
}
