// packages/ecs/src/archetype.ts — Archetype column storage
// Mertens: "Archetypes aggregate entities sharing identical component configurations."
import type { Entity } from "./entity.js";
import type { ObjectColumn, Float64Column } from "./storage.js";

// ═══════════════════════════════════════════════════════════
// Archetype — groups entities with identical component sets
// Mertens: "Archetypes aggregate entities sharing identical component configurations."
// ═══════════════════════════════════════════════════════════

export interface Archetype {
  id: number;
  type: string[]; // sorted component kinds
  columns: (ObjectColumn | Float64Column)[]; // SoA 列——isFloat64 字面量判别（免断言收窄）
  entities: Entity[]; // entity at each row — maintained during swap-and-pop
  addedTicks: number[][]; // addedTicks[col][row]
  changedTicks: number[][]; // changedTicks[col][row]
}

