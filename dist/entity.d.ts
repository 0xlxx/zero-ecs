declare const EntityBrand: unique symbol;
/**
 * Opaque entity handle — packed 32-bit: index(20) | generation(12).
 * Gregory §17.5: handle with stale reference detection.
 * When an entity is destroyed, its generation increments, making all
 * outstanding references invalid. A live entity is one whose packed
 * generation matches the current generation in the slot table.
 */
export type Entity = number & {
    [EntityBrand]: true;
};
export declare const INDEX_BITS = 20;
export declare const GEN_BITS = 12;
export declare const INDEX_MASK: number;
export declare const GEN_MASK: number;
export declare function packEntity(index: number, gen: number): Entity;
export declare function entityIndex(e: Entity): number;
export declare function entityGen(e: Entity): number;
/** Check if an entity is still alive. */
export declare function isAlive(e: Entity, generations: Uint16Array): boolean;
export {};
//# sourceMappingURL=entity.d.ts.map