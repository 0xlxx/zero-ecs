import type { Entity } from "./entity.js";
import type { ObjectColumn, Float64Column } from "./storage.js";
export interface Archetype {
    id: number;
    type: string[];
    columns: (ObjectColumn | Float64Column)[];
    entities: Entity[];
    addedTicks: number[][];
    changedTicks: number[][];
}
//# sourceMappingURL=archetype.d.ts.map