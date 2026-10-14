import type { Entity } from "./entity.js";
import type { World } from "./world.js";
import type { Component, ComponentFactory, ResourceFactory } from "./component.js";
export declare class EntityCommands {
    private _world;
    private _entity;
    constructor(world: World, entity: Entity);
    /** Queue a component insert on this entity. Returns this for chaining. */
    insert(component: Component): this;
    /** Queue removal of a component kind. Returns this for chaining. */
    remove(factory: ComponentFactory<unknown>): this;
    /** Queue despawn of this entity. Entity dies after flushDestroyed(). */
    despawn(): void;
    /** Return the entity ID. Valid immediately — even for pre-reserved spawn entities. */
    id(): Entity;
}
export declare class Commands {
    private _world;
    constructor(world: World);
    /**
     * Spawn a new entity with deferred component insertion.
     * Entity ID is reserved immediately — .id() returns a valid handle before flush.
     * Components are written when applyCommands() runs.
     */
    spawn(...components: Component[]): EntityCommands;
    /** Get EntityCommands for an existing entity. All mutations are deferred until flush. */
    entity(entity: Entity): EntityCommands;
    /** Queue a resource insert. Applied during flush. */
    insertResource<D>(factory: ResourceFactory<D>, data: D): void;
    /** Queue a resource removal. Applied during flush. */
    removeResource<D>(factory: ResourceFactory<D>): void;
}
//# sourceMappingURL=commands.d.ts.map