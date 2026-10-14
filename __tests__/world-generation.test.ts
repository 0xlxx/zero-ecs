// World generation / handle-space invariants — BDD regression guards

import { describe, expect, it } from "vitest";
import { World, defineComponent } from "@learnvis/ecs";
import type { Entity } from "@learnvis/ecs";

const C = defineComponent("worldGenerationProbe", { v: 0 });

const indexOf = (entity: Entity): number => (entity >>> 12) & ((1 << 20) - 1);

describe("Feature: Entity generation / index space", () => {
  it("Scenario: Given a slot is reused repeatedly — When generation is exhausted — Then the slot retires instead of reviving a stale handle", () => {
    const world = new World();
    const first = world.spawn([C()]);
    world.destroy(first);
    world.flushDestroyed();

    // Reuse the same slot through the full 12-bit generation range.
    for (let i = 0; i < 4095; i++) {
      const e = world.spawn([C()]);
      world.destroy(e);
      world.flushDestroyed();
    }

    const next = world.spawn([C()]);
    expect(world.isAlive(first)).toBe(false);
    // 旧 wrap 实现会回到同一 index 再分配；retire 必须换新 index。
    expect(indexOf(next)).not.toBe(indexOf(first));
  });

  it("Scenario: Given a fresh/retired World — When checking/destroying NULL_ENTITY — Then it is not alive and destroy is a no-op", () => {
    const world = new World();
    const nullEntity = 0 as Entity;

    expect(world.isAlive(nullEntity)).toBe(false);
    const before = world.entityCount();
    world.destroy(nullEntity);
    expect(world.entityCount()).toBe(before);

    // Also true for a retired slot: gen is set to 0.
    const first = world.spawn([C()]);
    world.destroy(first);
    world.flushDestroyed();
    world.destroy(0 as Entity);
    expect(world.entityCount()).toBe(before);
  });

  it("Scenario: Given the 20-bit index space is exhausted — When reserving — Then it throws instead of truncating", () => {
    const world = new World();
    (world as unknown as { _nextSlot: number })._nextSlot = 0x100000; // INDEX_MASK + 1
    expect(() => world.spawn([C()])).toThrow(/index space exhausted/);
  });

  it("Scenario: Given a query callback grows the generation table — When a later row is destroyed — Then the stale captured view cannot resurrect it", () => {
    const world = new World();
    const entities: Entity[] = [];
    for (let i = 0; i < 300; i++) entities.push(world.spawn([C()]));

    // Keep needAlive=true for the whole query.
    const throwaway = world.spawn([C()]);
    world.destroy(throwaway);

    let visitedDead = false;
    world.query(C).forEach((_c, entity) => {
      if (entity === entities[0]) {
        // Cross the initial 512-slot generation capacity while the query is live.
        for (let i = 0; i < 300; i++) world.spawn([C()]);
        world.destroy(entities[299]);
      }
      if (entity === entities[299]) visitedDead = true;
    });

    expect(visitedDead).toBe(false);
  });
});
