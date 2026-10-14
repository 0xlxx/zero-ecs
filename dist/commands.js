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
export class EntityCommands {
    constructor(world, entity) {
        this._world = world;
        this._entity = entity;
    }
    /** Queue a component insert on this entity. Returns this for chaining. */
    insert(component) {
        const entity = this._entity;
        this._world._enqueue(() => {
            this._world.addComponent(entity, component);
        });
        return this;
    }
    /** Queue removal of a component kind. Returns this for chaining. */
    remove(factory) {
        const entity = this._entity;
        this._world._enqueue(() => {
            this._world.removeComponent(entity, factory);
        });
        return this;
    }
    /** Queue despawn of this entity. Entity dies after flushDestroyed(). */
    despawn() {
        const entity = this._entity;
        this._world._enqueue(() => {
            this._world.destroy(entity);
        });
    }
    /** Return the entity ID. Valid immediately — even for pre-reserved spawn entities. */
    id() {
        return this._entity;
    }
}
export class Commands {
    constructor(world) {
        this._world = world;
    }
    /**
     * Spawn a new entity with deferred component insertion.
     * Entity ID is reserved immediately — .id() returns a valid handle before flush.
     * Components are written when applyCommands() runs.
     */
    spawn(...components) {
        const entity = this._world.reserveEntity();
        if (components.length > 0) {
            this._world._enqueue(() => {
                this._world._finishSpawn(entity, components);
            });
        }
        return new EntityCommands(this._world, entity);
    }
    /** Get EntityCommands for an existing entity. All mutations are deferred until flush. */
    entity(entity) {
        return new EntityCommands(this._world, entity);
    }
    /** Queue a resource insert. Applied during flush. */
    insertResource(factory, data) {
        this._world._enqueue(() => {
            this._world.insertResource(factory, data);
        });
    }
    /** Queue a resource removal. Applied during flush. */
    removeResource(factory) {
        this._world._enqueue(() => {
            this._world.removeResource(factory);
        });
    }
}
//# sourceMappingURL=commands.js.map