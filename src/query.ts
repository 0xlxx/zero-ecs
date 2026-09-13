// packages/ecs/src/query.ts — Bevy-style Query with filters
import type { Entity } from "./entity";
import type { ComponentFactory } from "./component";

// ═══════════════════════════════════════════════════════════
// Query
// ═══════════════════════════════════════════════════════════
// Query filters (Bevy-style: Changed<T>, Added<T>, With<T>, Without<T>)
// ═══════════════════════════════════════════════════════════

/** Bevy-style query filter descriptor. */
export type QueryFilter =
  | { kind: "changed"; factory: ComponentFactory<unknown> }
  | { kind: "added"; factory: ComponentFactory<unknown> }
  | { kind: "with"; factory: ComponentFactory<unknown> }
  | { kind: "without"; factory: ComponentFactory<unknown> };

/** Filter: entity where component T changed since last observation. */
export function Changed(factory: ComponentFactory<unknown>): QueryFilter {
  return { kind: "changed", factory };
}
/** Filter: entity where component T was added since last observation. */
export function Added(factory: ComponentFactory<unknown>): QueryFilter {
  return { kind: "added", factory };
}
/** Filter: entity HAS component T (but don't fetch it). */
export function With(factory: ComponentFactory<unknown>): QueryFilter {
  return { kind: "with", factory };
}
/** Filter: entity does NOT have component T. */
export function Without(factory: ComponentFactory<unknown>): QueryFilter {
  return { kind: "without", factory };
}

/** Extract the Data type from a ComponentFactory. */
type ExtractData<F> = F extends ComponentFactory<infer D> ? D : never;

/** Map a tuple of factories to a tuple of their Data types. */
type QueryCols<F extends readonly unknown[]> = { [K in keyof F]: ExtractData<F[K]> };

/** Map factories to column-array types for batch callback. */
type BatchCols<F extends readonly unknown[]> = { [K in keyof F]: ExtractData<F[K]>[] };

/** forEach callback: (component data..., Entity) — variadic tuple, any arity. */
type ForEachCallback<F extends readonly unknown[]> = (
  ...args: [...QueryCols<F>, Entity]
) => void;

/** batch callback: (column arrays..., Entity[], count) — variadic tuple, any arity. */
type BatchCallback<F extends readonly unknown[]> = (
  ...args: [...BatchCols<F>, Entity[], number]
) => void;

/** A lazy query object returned by world.query(...factories). */
export interface Query<F extends readonly ComponentFactory<unknown>[]> {
  /** Per-entity callback. Last arg is Entity. */
  forEach(callback: ForEachCallback<F>): void;
  /** Batch callback: column arrays + entities + count. Write inner loop for max throughput. */
  batch(callback: BatchCallback<F>): void;
  /** Return matching Entity[] (for manual iteration / destroy / conditional access). */
  entities(): Entity[];
  /** Return the first matching entity, or undefined if none. */
  first(): Entity | undefined;
  /** Add filters: Changed/Added/With/Without. Composite with AND logic. */
  filter(...filters: QueryFilter[]): Query<F>;
}
