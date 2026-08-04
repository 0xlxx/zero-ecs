// packages/ecs/src/entity.ts — Entity type + generation-based IDs
// Gregory §17.5: Handle = index + generation counter for stale reference detection.

declare const EntityBrand: unique symbol;
/**
 * Opaque entity handle — packed 32-bit: index(20) | generation(12).
 * Gregory §17.5: handle with stale reference detection.
 * When an entity is destroyed, its generation increments, making all
 * outstanding references invalid. A live entity is one whose packed
 * generation matches the current generation in the slot table.
 */
export type Entity = number & { [EntityBrand]: true };

// ── Entity packing helpers ──

export const INDEX_BITS = 20;
export const GEN_BITS = 12;
export const INDEX_MASK = (1 << INDEX_BITS) - 1; // 0xFFFFF
export const GEN_MASK = (1 << GEN_BITS) - 1; // 0xFFF

export function packEntity(index: number, gen: number): Entity {
  return (((index & INDEX_MASK) << GEN_BITS) | (gen & GEN_MASK)) as Entity;
}
export function entityIndex(e: Entity): number {
  return (e >>> GEN_BITS) & INDEX_MASK;
}
export function entityGen(e: Entity): number {
  return e & GEN_MASK;
}

/** Check if an entity is still alive. */
export function isAlive(e: Entity, generations: Uint16Array): boolean {
  const idx = entityIndex(e);
  return idx < generations.length && entityGen(e) === generations[idx];
}

/** Per-slot generation table. Lazily grown on demand.
 *  Use resizeGenerations() to replace, getGenerations() to read. */
let _generations: Uint16Array = new Uint16Array(256);
export function getGenerations(): Uint16Array {
  return _generations;
}
export function resizeGenerations(size: number): void {
  _generations = new Uint16Array(size);
}

/** Free slot stack (LIFO). */
export const _freeSlots: number[] = [];

/** Mutable slot state — use _entityState.nextSlot for writes. */
export const _entityState = {
  nextSlot: 0,
};
