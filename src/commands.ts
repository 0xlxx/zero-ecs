// packages/ecs/src/commands.ts — Bevy-style Commands + EntityCommands
//
// Deferred mutation queue. Systems construct a Commands instance and call
// spawn/entity/insertResource — all mutations are queued as closures and
// applied atomically when World.applyCommands() runs (after each system).
//
// Usage:
//   const cmd = new Commands(world);
//   cmd.spawn(Transform({x:1})).insert(Label({text:"hi"}));
//   cmd.entity(existing).remove(OldComponent).insert(NewComponent({...}));
//   cmd.entity(existing).despawn();

import type { Entity } from "./entity";
import type { World } from "./world";
import type { Component, ComponentFactory, ResourceFactory, DataOf } from "./component";

export class EntityCommands {
  private _world: World;
  private _entity: Entity;

  constructor(world: World, entity: Entity) {
    this._world = world;
    this._entity = entity;
  }

  /** Queue a component insert on this entity. Returns this for chaining. */
  insert(component: Component): this {
    const entity = this._entity;
    this._world._enqueue(() => {
      this._world.addComponent(entity, component);
    });
    return this;
  }

  /** Queue a component insert only if the component kind doesn't already exist on the entity.
   *  Check is performed at execution time, not queue time. */
  insertIfNew(component: Component): this {
    const entity = this._entity;
    const kind = component.type;
    this._world._enqueue(() => {
      if (!this._world._hasComponentKind(entity, kind)) {
        this._world.addComponent(entity, component);
      }
    });
    return this;
  }

  /** Queue a component insert only if the value differs from what's already on the entity.
   *  Uses shallow value comparison (JSON). Check is performed at execution time. */
  insertIfNeq(component: Component): this {
    const entity = this._entity;
    this._world._enqueue(() => {
      const existing = this._world._getComponentRaw(entity, component.type);
      if (existing === undefined) {
        this._world.addComponent(entity, component);
        return;
      }
      // Shallow compare — strip the 'type' key and compare the data fields
      const { type: _, ...newFields } = component as Record<string, unknown>;
      const { type: __, ...oldFields } = existing as Record<string, unknown>;
      if (JSON.stringify(newFields) !== JSON.stringify(oldFields)) {
        this._world.addComponent(entity, component);
      }
    });
    return this;
  }

  /** Queue removal of a component kind. Returns this for chaining. */
  remove(factory: ComponentFactory<unknown>): this {
    const entity = this._entity;
    this._world._enqueue(() => {
      this._world.removeComponent(entity, factory);
    });
    return this;
  }

  /** Queue despawn of this entity. Entity dies after flushDestroyed(). */
  despawn(): void {
    const entity = this._entity;
    this._world._enqueue(() => {
      this._world.destroy(entity);
    });
  }

  /** Return the entity ID. Valid immediately — even for pre-reserved spawn entities. */
  id(): Entity {
    return this._entity;
  }
}

export class Commands {
  private _world: World;

  constructor(world: World) {
    this._world = world;
  }

  /**
   * Spawn a new entity with deferred component insertion.
   * Entity ID is reserved immediately — .id() returns a valid handle before flush.
   * Components are written when applyCommands() runs.
   */
  spawn(...components: Component[]): EntityCommands {
    const entity = this._world.reserveEntity();
    if (components.length > 0) {
      this._world._enqueue(() => {
        this._world._finishSpawn(entity, components);
      });
    }
    return new EntityCommands(this._world, entity);
  }

  /** Get EntityCommands for an existing entity. All mutations are deferred until flush. */
  entity(entity: Entity): EntityCommands {
    return new EntityCommands(this._world, entity);
  }

  /** Queue a resource insert. Applied during flush. */
  // oxlint-disable-next-line typescript/no-explicit-any -- 泛型约束方法逆变必要
  insertResource<F extends ResourceFactory<any>>(factory: F, data: DataOf<F>): void {
    this._world._enqueue(() => {
      this._world.insertResource(factory, data);
    });
  }

  /** Queue a resource removal. Applied during flush. */
  // oxlint-disable-next-line typescript/no-explicit-any -- 泛型约束方法逆变必要
  removeResource<F extends ResourceFactory<any>>(factory: F): void {
    this._world._enqueue(() => {
      this._world.removeResource(factory);
    });
  }

  /** Queue an arbitrary mutation with errors silently swallowed.
   *  Equivalent to Bevy's `queue_silenced()`. */
  silenced(fn: () => void): void {
    this._world._enqueue(() => {
      try { fn(); } catch { /* silenced */ }
    });
  }
}
