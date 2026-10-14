// packages/ecs/src/query.ts — Bevy-style Query with filters
import type { Entity } from "./entity.js";
import type { ComponentFactory } from "./component.js";

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

/**
 * Persistent per-query change-detection cursors.
 *
 * A QueryState belongs to one logical query reader. Reuse the same state across
 * frames, but never share it between independent readers that need independent
 * Changed/Added observation. QueryState is caller-owned: retire destroyed
 * entities with forget() or call clear() when the reader is no longer needed.
 */
export class QueryState {
  private added = new Map<Entity, Map<string, number>>();
  private changed = new Map<Entity, Map<string, number>>();

  readAdded(entity: Entity, kind: string): number {
    return this.added.get(entity)?.get(kind) ?? 0;
  }

  writeAdded(entity: Entity, kind: string, tick: number): void {
    let kinds = this.added.get(entity);
    if (!kinds) {
      kinds = new Map();
      this.added.set(entity, kinds);
    }
    kinds.set(kind, tick);
  }

  readChanged(entity: Entity, kind: string): number {
    return this.changed.get(entity)?.get(kind) ?? 0;
  }

  writeChanged(entity: Entity, kind: string, tick: number): void {
    let kinds = this.changed.get(entity);
    if (!kinds) {
      kinds = new Map();
      this.changed.set(entity, kinds);
    }
    kinds.set(kind, tick);
  }

  forget(entity: Entity): void {
    this.added.delete(entity);
    this.changed.delete(entity);
  }

  clear(): void {
    this.added.clear();
    this.changed.clear();
  }
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
