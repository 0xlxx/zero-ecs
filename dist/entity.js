// packages/ecs/src/entity.ts — Entity type + generation-based IDs
// Gregory §17.5: Handle = index + generation counter for stale reference detection.
// ── Entity packing helpers ──
export const INDEX_BITS = 20;
export const GEN_BITS = 12;
export const INDEX_MASK = (1 << INDEX_BITS) - 1; // 0xFFFFF
export const GEN_MASK = (1 << GEN_BITS) - 1; // 0xFFF
export function packEntity(index, gen) {
    return (((index & INDEX_MASK) << GEN_BITS) | (gen & GEN_MASK));
}
export function entityIndex(e) {
    return (e >>> GEN_BITS) & INDEX_MASK;
}
export function entityGen(e) {
    return e & GEN_MASK;
}
/** Check if an entity is still alive. */
export function isAlive(e, generations) {
    const idx = entityIndex(e);
    const gen = entityGen(e);
    return gen !== 0 && idx < generations.length && gen === generations[idx];
}
//# sourceMappingURL=entity.js.map