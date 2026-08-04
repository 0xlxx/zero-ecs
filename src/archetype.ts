// packages/ecs/src/archetype.ts — Archetype column storage
// Mertens: "Archetypes aggregate entities sharing identical component configurations."
import type { Entity } from "./entity";
import type { Column } from "./storage";

// ═══════════════════════════════════════════════════════════
// Archetype — groups entities with identical component sets
// Mertens: "Archetypes aggregate entities sharing identical component configurations."
// ═══════════════════════════════════════════════════════════

export interface Archetype {
  id: number;
  type: string[]; // sorted component kinds
  columns: Column[]; // one column per component (ObjectColumn or Float64Column)
  entities: Entity[]; // entity at each row — maintained during swap-and-pop
  addedTicks: number[][]; // addedTicks[col][row]
  changedTicks: number[][]; // changedTicks[col][row]
  masterChanged: number[]; // max changed tick per row — O(1) filter shortcut
  masterAdded: number[]; // max added tick per row
}

