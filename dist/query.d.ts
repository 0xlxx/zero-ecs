import type { Entity } from "./entity.js";
import type { ComponentFactory } from "./component.js";
/** Bevy-style query filter descriptor. */
export type QueryFilter = {
    kind: "changed";
    factory: ComponentFactory<unknown>;
} | {
    kind: "added";
    factory: ComponentFactory<unknown>;
} | {
    kind: "with";
    factory: ComponentFactory<unknown>;
} | {
    kind: "without";
    factory: ComponentFactory<unknown>;
};
/** Filter: entity where component T changed since last observation. */
export declare function Changed(factory: ComponentFactory<unknown>): QueryFilter;
/** Filter: entity where component T was added since last observation. */
export declare function Added(factory: ComponentFactory<unknown>): QueryFilter;
/** Filter: entity HAS component T (but don't fetch it). */
export declare function With(factory: ComponentFactory<unknown>): QueryFilter;
/** Filter: entity does NOT have component T. */
export declare function Without(factory: ComponentFactory<unknown>): QueryFilter;
/**
 * Persistent per-query change-detection cursors.
 *
 * A QueryState belongs to one logical query reader. Reuse the same state across
 * frames, but never share it between independent readers that need independent
 * Changed/Added observation. QueryState is caller-owned: retire destroyed
 * entities with forget() or call clear() when the reader is no longer needed.
 */
export declare class QueryState {
    private added;
    private changed;
    readAdded(entity: Entity, kind: string): number;
    writeAdded(entity: Entity, kind: string, tick: number): void;
    readChanged(entity: Entity, kind: string): number;
    writeChanged(entity: Entity, kind: string, tick: number): void;
    forget(entity: Entity): void;
    clear(): void;
}
/** Extract the Data type from a ComponentFactory. */
type ExtractData<F> = F extends ComponentFactory<infer D> ? D : never;
/** Map a tuple of factories to a tuple of their Data types. */
type QueryCols<F extends readonly unknown[]> = {
    [K in keyof F]: ExtractData<F[K]>;
};
/** Map factories to column-array types for batch callback. */
type BatchCols<F extends readonly unknown[]> = {
    [K in keyof F]: ExtractData<F[K]>[];
};
/** forEach callback: (component data..., Entity) — variadic tuple, any arity. */
type ForEachCallback<F extends readonly unknown[]> = (...args: [...QueryCols<F>, Entity]) => void;
/** batch callback: (column arrays..., Entity[], count) — variadic tuple, any arity. */
type BatchCallback<F extends readonly unknown[]> = (...args: [...BatchCols<F>, Entity[], number]) => void;
/** A lazy query object returned by world.query(...factories). */
export interface Query<F extends readonly ComponentFactory<unknown>[]> {
    /** Read-only per-entity callback on the live column fast path. Last arg is Entity.
     * Do not structurally mutate the queried entity set here; use World.queryMut(). */
    forEach(callback: ForEachCallback<F>): void;
    /** Batch callback: column arrays + entities + count. Write inner loop for max throughput. */
    batch(callback: BatchCallback<F>): void;
    /** Return matching Entity[] (for manual iteration / destroy / conditional access). */
    entities(): Entity[];
    /** Return the first matching entity, or undefined if none. */
    first(): Entity | undefined;
    /** Add filters: Changed/Added/With/Without. Composite with AND logic. */
    filter(...filters: QueryFilter[]): Query<F>;
    /** Bind this query to persistent per-query Changed/Added cursors. */
    withState(state: QueryState): Query<F>;
}
export {};
//# sourceMappingURL=query.d.ts.map