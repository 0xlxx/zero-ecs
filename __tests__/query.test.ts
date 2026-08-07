// @vitest-environment jsdom
// Query + Filter unit tests — Bevy-style Query API
//
// Covers: entities(), filter(Changed/Added/With/Without), forEach, batch

import { describe, it, expect, beforeEach } from "vitest";
import { World, defineComponent, defineResource, Changed, Added, With, Without } from "@learnvis/ecs";
import type { Entity, ComponentFactory } from "@learnvis/ecs";

// ── Test components ──

const Position = defineComponent("position", { x: 0, y: 0 });
const Velocity = defineComponent("velocity", { dx: 0, dy: 0 });
const Health   = defineComponent("health", { value: 100 });
const Tag      = defineComponent("tag", { name: "" });

function spawn(world: World, ...factories: ComponentFactory<any>[]): Entity {
  return world.spawn(factories.map(f => f.create()));
}

function set<D>(world: World, entity: Entity, factory: ComponentFactory<D>, overrides: Partial<D>): void {
  world.setComponent(entity, factory.create(overrides));
}

// ═══════════════════════════════════════════════════════════
// Query.entities() — basic matching
// ═══════════════════════════════════════════════════════════

describe("Query.entities", () => {
  let world: World;

  beforeEach(() => { world = new World(); });

  // ── Right (happy path) ──

  it("returns matching entities for a single kind", () => {
    const a = spawn(world, Position);
    const b = spawn(world, Position);
    spawn(world, Velocity); // should NOT match

    const result = world.query(Position).entities();

    expect(result).toHaveLength(2);
    expect(result).toContain(a);
    expect(result).toContain(b);
  });

  it("returns intersection for multiple kinds", () => {
    const e1 = spawn(world, Position, Velocity);
    const e2 = spawn(world, Position, Velocity);
    spawn(world, Position); // missing Velocity → excluded

    const result = world.query(Position, Velocity).entities();

    expect(result).toHaveLength(2);
    expect(result).toContain(e1);
    expect(result).toContain(e2);
  });

  it("returns empty array when no entities have all kinds", () => {
    spawn(world, Position);
    spawn(world, Velocity);

    const result = world.query(Position, Velocity).entities();

    expect(result).toHaveLength(0);
  });

  // ── Boundary ──

  it("returns empty array when world is empty", () => {
    const result = world.query(Position).entities();

    expect(result).toHaveLength(0);
  });

  it("handles zero factories gracefully", () => {
    const result = world.query().entities();

    expect(result).toHaveLength(0);
  });

  it("excludes destroyed entities", () => {
    const e = spawn(world, Position);
    world.destroy(e);
    world.flushDestroyed();

    const result = world.query(Position).entities();

    expect(result).toHaveLength(0);
  });

  it("handles component added via setComponent after spawn", () => {
    const e = spawn(world, Position);
    // add Velocity after spawn
    world.setComponent(e, Velocity.create({ dx: 1, dy: 0 }));

    const result = world.query(Position, Velocity).entities();

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(e);
  });

  // ── Inverse ──

  it("removed component excludes entity from query", () => {
    const e = spawn(world, Position, Velocity);
    world.removeComponent(e, Velocity);

    const result = world.query(Position, Velocity).entities();

    expect(result).toHaveLength(0);
  });

  // ── Cross-check ──

  it("entities() and forEach return consistent entity sets", () => {
    spawn(world, Position, Velocity);
    spawn(world, Position, Velocity);
    const entitiesViaEntities = world.query(Position, Velocity).entities();
    const entitiesViaForEach: Entity[] = [];
    world.query(Position, Velocity).forEach((_pos, _vel, e) => entitiesViaForEach.push(e));

    expect(entitiesViaEntities.sort()).toEqual(entitiesViaEntities.sort());
    expect(entitiesViaForEach).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════
// Filter: Changed<T> + Added<T>
// ═══════════════════════════════════════════════════════════

describe("Filter.Changed", () => {
  let world: World;

  beforeEach(() => { world = new World(); });

  it("matches entities whose component was just set", () => {
    const e = spawn(world, Position);

    // setComponent triggers Changed
    set(world, e, Position, { x: 10, y: 20 });

    const result = world.query(Position).filter(Changed(Position)).entities();

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(e);
  });

  it("does not match entities that were not modified since last observation", () => {
    spawn(world, Position);

    // First observation — Changed fires once because component was just added
    const first = world.query(Position).filter(Changed(Position)).entities();
    expect(first).toHaveLength(1);

    // Second observation — no change since last observation
    const second = world.query(Position).filter(Changed(Position)).entities();

    expect(second).toHaveLength(0);
  });

  it("matches again after component is updated", () => {
    const e = spawn(world, Position);

    // Observe once
    world.query(Position).filter(Changed(Position)).entities();

    // Update
    set(world, e, Position, { x: 5, y: 5 });

    // Should match again
    const result = world.query(Position).filter(Changed(Position)).entities();

    expect(result).toHaveLength(1);
  });

  it("Changed is per-observer — different observers see independent ticks", () => {
    const e = spawn(world, Position);
    set(world, e, Position, { x: 1, y: 1 });

    // Observer "A" sees the change
    world.setCurrentObserver("A");
    const r1 = world.query(Position).filter(Changed(Position)).entities();
    expect(r1).toHaveLength(1);

    // Observer "B" also sees it (independent last-seen ticks)
    world.setCurrentObserver("B");
    const r2 = world.query(Position).filter(Changed(Position)).entities();
    expect(r2).toHaveLength(1);
  });

  it("returns empty when no entity changed the given component", () => {
    spawn(world, Position);
    world.query(Position).filter(Changed(Position)).entities(); // observe

    const result = world.query(Position).filter(Changed(Position)).entities();

    expect(result).toHaveLength(0);
  });
});

describe("Filter.Added", () => {
  let world: World;

  beforeEach(() => { world = new World(); });

  it("matches entities that just received the component", () => {
    const e = spawn(world, Position);

    const result = world.query(Position).filter(Added(Position)).entities();

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(e);
  });

  it("does not match on second observation", () => {
    spawn(world, Position);
    world.query(Position).filter(Added(Position)).entities(); // first observe

    const result = world.query(Position).filter(Added(Position)).entities();

    expect(result).toHaveLength(0);
  });

  it("does not match after setComponent on existing component", () => {
    const e = spawn(world, Position);
    world.query(Position).filter(Added(Position)).entities(); // observe the add
    set(world, e, Position, { x: 99, y: 99 });

    const result = world.query(Position).filter(Added(Position)).entities();

    expect(result).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// Filter: With<T> + Without<T>
// ═══════════════════════════════════════════════════════════

describe("Filter.With", () => {
  let world: World;

  beforeEach(() => { world = new World(); });

  it("includes entities that have the specified component", () => {
    spawn(world, Position, Velocity);
    spawn(world, Position); // no Velocity

    const result = world.query(Position).filter(With(Velocity)).entities();

    expect(result).toHaveLength(1);
  });

  it("returns empty when no entity has the required component", () => {
    spawn(world, Position);

    const result = world.query(Position).filter(With(Health)).entities();

    expect(result).toHaveLength(0);
  });

  it("works with multiple With filters (AND)", () => {
    spawn(world, Position, Velocity, Health);
    spawn(world, Position, Velocity); // missing Health

    const result = world.query(Position).filter(With(Velocity), With(Health)).entities();

    expect(result).toHaveLength(1);
  });
});

describe("Filter.Without", () => {
  let world: World;

  beforeEach(() => { world = new World(); });

  it("excludes entities that have the specified component", () => {
    spawn(world, Position, Velocity);
    const e = spawn(world, Position); // no Velocity

    const result = world.query(Position).filter(Without(Velocity)).entities();

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(e);
  });

  it("includes all entities when no entity has the excluded component", () => {
    spawn(world, Position);
    spawn(world, Position);

    const result = world.query(Position).filter(Without(Velocity)).entities();

    expect(result).toHaveLength(2);
  });

  it("returns empty when all entities have the excluded component", () => {
    spawn(world, Position, Velocity);
    spawn(world, Position, Velocity);

    const result = world.query(Position).filter(Without(Velocity)).entities();

    expect(result).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// Filter: combined Changed + Added + With + Without
// ═══════════════════════════════════════════════════════════

describe("Filter combined", () => {
  let world: World;

  beforeEach(() => { world = new World(); });

  it("Changed AND With — only entities that changed AND have the component", () => {
    const e = spawn(world, Position, Velocity);
    spawn(world, Position); // no Velocity
    set(world, e, Position, { x: 1, y: 1 }); // only e changed

    const result = world.query(Position).filter(Changed(Position), With(Velocity)).entities();

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(e);
  });

  it("Changed AND Without — excludes entities with the component", () => {
    const e1 = spawn(world, Position, Velocity);
    const e2 = spawn(world, Position); // no Velocity
    set(world, e1, Position, { x: 1, y: 1 });
    set(world, e2, Position, { x: 2, y: 2 });

    const result = world.query(Position).filter(Changed(Position), Without(Velocity)).entities();

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(e2);
  });

  it("all four filters combined", () => {
    const e = spawn(world, Position, Velocity, Health);
    spawn(world, Position, Velocity); // no Health
    set(world, e, Position, { x: 1, y: 1 });

    const result = world.query(Position)
      .filter(Changed(Position), With(Velocity), Without(Tag), Added(Health))
      .entities();

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(e);
  });
});

// ═══════════════════════════════════════════════════════════
// Query.forEach — callback receives data + entity
// ═══════════════════════════════════════════════════════════

describe("Query.forEach", () => {
  let world: World;

  beforeEach(() => { world = new World(); });

  it("receives component data and entity in callback", () => {
    const e = spawn(world, Position, Velocity);
    set(world, e, Position, { x: 10, y: 20 });
    set(world, e, Velocity, { dx: 1, dy: 0 });

    const results: Array<{ x: number; y: number; dx: number; dy: number; entity: Entity }> = [];
    world.query(Position, Velocity).forEach((pos, vel, entity) => {
      results.push({ x: pos.x, y: pos.y, dx: vel.dx, dy: vel.dy, entity });
    });

    expect(results).toHaveLength(1);
    expect(results[0].x).toBe(10);
    expect(results[0].y).toBe(20);
    expect(results[0].dx).toBe(1);
    expect(results[0].dy).toBe(0);
    expect(results[0].entity).toBe(e);
  });

  it("iterates only matching entities with Changed filter", () => {
    const e = spawn(world, Position);
    const other = spawn(world, Position);
    void other;

    // Observe initial state — consume the "added" Changed ticks
    world.query(Position).filter(Changed(Position)).entities();

    // Only update e
    set(world, e, Position, { x: 99, y: 99 });

    const entities: Entity[] = [];
    world.query(Position).filter(Changed(Position)).forEach((_pos, entity) => {
      entities.push(entity);
    });

    expect(entities).toHaveLength(1);
    expect(entities[0]).toBe(e);
  });

  it("skips destroyed entities during iteration", () => {
    spawn(world, Position);
    const e = spawn(world, Position);
    void e;

    const entities: Entity[] = [];
    world.query(Position).forEach((_pos, entity) => {
      entities.push(entity);
    });

    expect(entities).toHaveLength(2);
  });

  it("does not invoke callback when no entities match", () => {
    let called = false;
    world.query(Position).forEach(() => { called = true; });

    expect(called).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// Query.batch
// ═══════════════════════════════════════════════════════════

describe("Query.batch", () => {
  let world: World;

  beforeEach(() => { world = new World(); });

  it("passes column arrays + entities + count (single and multi kind)", () => {
    const a = spawn(world, Position, Velocity);
    const b = spawn(world, Position, Velocity);
    set(world, a, Position, { x: 1, y: 2 });
    set(world, b, Position, { x: 3, y: 4 });

    let count = 0;
    const seen: Entity[] = [];
    world.query(Position, Velocity).batch((positions, velocities, entities, n) => {
      count = n;
      for (let i = 0; i < n; i++) {
        seen.push(entities[i]);
        expect(positions[i].x).toBe(i === 0 ? 1 : 3);
        expect(velocities[i].dx).toBe(0);
      }
    });

    expect(count).toBe(2);
    expect(seen).toContain(a);
    expect(seen).toContain(b);
  });

  it("skips destroyed entities", () => {
    const a = spawn(world, Position);
    const b = spawn(world, Position);
    world.destroy(a);
    (world as unknown as { flushDestroyed(): void }).flushDestroyed();

    const seen: Entity[] = [];
    world.query(Position).batch((_positions, entities, count) => {
      for (let i = 0; i < count; i++) seen.push(entities[i]);
    });
    expect(seen).toEqual([b]);
  });

  it("regression: callback may move matched entities to another archetype",
    () => {
      // The old fast path passed LIVE column/entity arrays to the callback.
      // Adding a component inside the callback moves the entity to a new
      // archetype (swap-remove from the live arrays) → later rows read
      // undefined. Batch must snapshot rows before invoking the callback.
      const n = 8;
      const entities: Entity[] = [];
      for (let i = 0; i < n; i++) entities.push(spawn(world, Position, Velocity));

      const seen: Entity[] = [];
      let undefinedRow = false;
      world.query(Position, Velocity).batch((positions, _velocities, ents, count) => {
        for (let i = 0; i < count; i++) {
          if (!positions[i] || ents[i] === undefined) {
            undefinedRow = true;
            continue;
          }
          seen.push(ents[i]);
          // Move THIS entity out of the queried archetype mid-iteration.
          world.setComponent(ents[i], Tag.create());
        }
      });

      expect(undefinedRow).toBe(false);
      expect(seen).toHaveLength(n); // snapshot semantics — every row processed
      for (const e of entities) expect(seen).toContain(e);
      // All entities moved to the Tag archetype and remain intact.
      for (const e of entities) {
        expect(world.getComponent(e, Tag)).toBeDefined();
        expect(world.getComponent(e, Position)).toBeDefined();
      }
    },
  );

  it("supports Changed filters (row-level)", () => {
    const e = spawn(world, Position);
    const other = spawn(world, Position);
    void other;
    world.query(Position).filter(Changed(Position)).entities(); // consume Added
    set(world, e, Position, { x: 7, y: 7 });

    const seen: Entity[] = [];
    world.query(Position).filter(Changed(Position)).batch((_positions, entities, count) => {
      for (let i = 0; i < count; i++) seen.push(entities[i]);
    });
    expect(seen).toEqual([e]);
  });
});

// ═══════════════════════════════════════════════════════════
// Query.filter chaining
// ═══════════════════════════════════════════════════════════

describe("Query.filter chaining", () => {
  let world: World;

  beforeEach(() => { world = new World(); });

  it("filter returns a Query that supports further filter calls", () => {
    spawn(world, Position, Velocity);
    spawn(world, Position);

    const result = world.query(Position)
      .filter(With(Velocity))
      .filter(Without(Health))
      .entities();

    expect(result).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════
// Edge cases — Boundary
// ═══════════════════════════════════════════════════════════

describe("Edge cases — Boundary", () => {
  let world: World;

  beforeEach(() => { world = new World(); });

  it("should handle entity spawned with many components", () => {
    const e = spawn(world, Position, Velocity, Health, Tag);

    const result = world.query(Position, Velocity, Health, Tag).entities();

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(e);
  });

  it("should handle zero-value coordinates", () => {
    const e = spawn(world, Position);
    set(world, e, Position, { x: 0, y: 0 });

    const result = world.query(Position).entities();

    expect(result).toHaveLength(1);
    // Data read via getComponent — not query responsibility, but consistent
    const pos = world.getComponent(e, Position);
    expect(pos!.x).toBe(0);
    expect(pos!.y).toBe(0);
  });

  it("should handle negative coordinates", () => {
    const e = spawn(world, Position);
    set(world, e, Position, { x: -5, y: -10 });

    const result = world.query(Position).entities();

    expect(result).toHaveLength(1);
  });

  it("should handle many entities with different archetypes", () => {
    // Creates: Position-only, Position+Velocity, Position+Health, Position+Velocity+Health
    const ids: Entity[] = [];
    ids.push(spawn(world, Position));
    ids.push(spawn(world, Position, Velocity));
    ids.push(spawn(world, Position, Health));
    ids.push(spawn(world, Position, Velocity, Health));

    // Query Position+Velocity — should match 2 (with Velocity)
    const result = world.query(Position, Velocity).entities();

    expect(result).toHaveLength(2);
  });

  it("should handle entity with component removed and re-added", () => {
    const e = spawn(world, Position, Velocity);
    world.removeComponent(e, Velocity);
    world.setComponent(e, Velocity.create({ dx: 5, dy: 5 }));

    const result = world.query(Position, Velocity).entities();

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(e);
  });
});

// ═══════════════════════════════════════════════════════════
// Edge cases — Inverse (round-trip)
// ═══════════════════════════════════════════════════════════

describe("Edge cases — Inverse", () => {
  let world: World;

  beforeEach(() => { world = new World(); });

  it("entities() and forEach should agree on entity set with Changed filter", () => {
    const e = spawn(world, Position);
    spawn(world, Position);
    set(world, e, Position, { x: 1, y: 1 });

    // Use separate observers so each query gets independent Changed tracking
    world.setCurrentObserver("entities-test");
    const fromEntities = world.query(Position).filter(Changed(Position)).entities();

    world.setCurrentObserver("forEach-test");
    const fromForEach: Entity[] = [];
    world.query(Position).filter(Changed(Position)).forEach((_pos, entity) => fromForEach.push(entity));

    expect(fromEntities.sort()).toEqual(fromForEach.sort());
  });

  it("entities() and forEach should agree with With+Without filters", () => {
    spawn(world, Position, Velocity, Health);
    spawn(world, Position, Velocity);
    spawn(world, Position);

    const fromEntities = world.query(Position).filter(With(Velocity), Without(Health)).entities();
    const fromForEach: Entity[] = [];
    world.query(Position).filter(With(Velocity), Without(Health)).forEach((_pos, entity) => fromForEach.push(entity));

    expect(fromEntities.sort()).toEqual(fromForEach.sort());
    expect(fromForEach).toHaveLength(1); // Position+Velocity, no Health
  });

  it("setComponent → query → setComponent → query round-trip", () => {
    const e = spawn(world, Position);

    // Round 1
    set(world, e, Position, { x: 1, y: 1 });
    world.query(Position).filter(Changed(Position)).entities(); // observe
    expect(world.query(Position).filter(Changed(Position)).entities()).toHaveLength(0);

    // Round 2
    set(world, e, Position, { x: 2, y: 2 });
    expect(world.query(Position).filter(Changed(Position)).entities()).toHaveLength(1);

    // Round 3 — no change
    expect(world.query(Position).filter(Changed(Position)).entities()).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// Edge cases — Cross-check
// ═══════════════════════════════════════════════════════════

describe("Edge cases — Cross-check", () => {
  let world: World;

  beforeEach(() => { world = new World(); });

  it("two independent queries on same world return consistent results", () => {
    const e = spawn(world, Position, Velocity);
    void e;
    spawn(world, Position);

    const q1 = world.query(Position).filter(With(Velocity));
    const q2 = world.query(Position).filter(With(Velocity));

    expect(q1.entities()).toEqual(q2.entities());
  });

  it("getComponent after query returns same data", () => {
    const e = spawn(world, Position, Velocity);
    set(world, e, Position, { x: 42, y: 99 });

    const posFromQuery: any[] = [];
    world.query(Position, Velocity).forEach((pos, _vel, _entity) => {
      posFromQuery.push({ x: pos.x, y: pos.y });
    });

    const posFromGet = world.getComponent(e, Position);

    expect(posFromQuery[0].x).toBe(posFromGet!.x);
    expect(posFromQuery[0].y).toBe(posFromGet!.y);
  });
});

// ═══════════════════════════════════════════════════════════
// Error conditions
// ═══════════════════════════════════════════════════════════

describe("Query error handling", () => {
  let world: World;

  beforeEach(() => { world = new World(); });

  it("entities() does not throw when all entities are destroyed mid-query", () => {
    const e1 = spawn(world, Position);
    const e2 = spawn(world, Position);
    world.destroy(e1);
    world.destroy(e2);
    world.flushDestroyed();

    expect(() => world.query(Position).entities()).not.toThrow();
    expect(world.query(Position).entities()).toHaveLength(0);
  });

  it("forEach handles component that was removed between spawn and query", () => {
    const e = spawn(world, Position, Velocity);
    world.removeComponent(e, Velocity);

    // Querying Position+Velocity — e should not match (no Velocity)
    const result = world.query(Position, Velocity).entities();
    expect(result).toHaveLength(0);
  });

  it("handles filter with component not present in any entity", () => {
    spawn(world, Position);

    expect(() =>
      world.query(Position).filter(Changed(Health)).entities()
    ).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════
// World Resources — Bevy-style Res<T>
// ═══════════════════════════════════════════════════════════

describe("World Resources", () => {
  let world: World;

  const Config = defineComponent("config", { debug: false, scale: 1.0 });

  beforeEach(() => { world = new World(); });

  it("should return undefined for a resource that hasn't been inserted", () => {
    expect(world.resource(Config)).toBeUndefined();
  });

  it("should return false from hasResource for missing resource", () => {
    expect(world.hasResource(Config)).toBe(false);
  });

  it("should insert and retrieve a resource", () => {
    world.insertResource(Config, { debug: true, scale: 2.5 });

    const r = world.resource(Config);
    expect(r).toBeDefined();
    expect(r!.debug).toBe(true);
    expect(r!.scale).toBe(2.5);
  });

  it("should report hasResource true after insert", () => {
    world.insertResource(Config, { debug: false, scale: 1 });

    expect(world.hasResource(Config)).toBe(true);
  });

  it("should overwrite on second insertResource", () => {
    world.insertResource(Config, { debug: false, scale: 1 });
    world.insertResource(Config, { debug: true, scale: 3 });

    const r = world.resource(Config);
    expect(r!.debug).toBe(true);
    expect(r!.scale).toBe(3);
  });

  it("should return undefined after removeResource", () => {
    world.insertResource(Config, { debug: true, scale: 1 });
    world.removeResource(Config);

    expect(world.resource(Config)).toBeUndefined();
    expect(world.hasResource(Config)).toBe(false);
  });

  it("should not throw when removing a non-existent resource", () => {
    expect(() => world.removeResource(Config)).not.toThrow();
  });

  it("should isolate resources by factory kind", () => {
    const Other = defineComponent("other", { name: "" });
    world.insertResource(Config, { debug: true, scale: 1 });
    world.insertResource(Other, { name: "test" });

    expect(world.hasResource(Config)).toBe(true);
    expect(world.hasResource(Other)).toBe(true);

    world.removeResource(Config);
    expect(world.hasResource(Config)).toBe(false);
    expect(world.hasResource(Other)).toBe(true);
  });

  it("should survive entity spawn/destroy cycles", () => {
    world.insertResource(Config, { debug: false, scale: 2 });

    const e = spawn(world, Position);
    world.destroy(e);
    world.flushDestroyed();

    expect(world.resource(Config)!.scale).toBe(2);
  });

  it("should be readable during onAdd hook", () => {
    world.insertResource(Config, { debug: true, scale: 1 });

    let capturedScale = 0;
    world.onAdd(Position, () => {
      capturedScale = world.resource(Config)!.scale;
    });

    spawn(world, Position);
    expect(capturedScale).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════
// defineResource — resource stored on entity with tick tracking
// ═══════════════════════════════════════════════════════════

describe("defineResource", () => {
  let world: World;

  const DataStore = defineResource<Map<string, unknown>>("dataStore");

  beforeEach(() => { world = new World(); });

  it("should insert and retrieve a resource via defineResource key", () => {
    const map = new Map([["a", 1]]);
    world.insertResource(DataStore, map);

    const r = world.resource(DataStore);
    expect(r).toBeDefined();
    expect(r!.get("a")).toBe(1);
    expect(r!.size).toBe(1);
  });

  it("should return undefined for a resource that hasn't been inserted", () => {
    expect(world.resource(DataStore)).toBeUndefined();
  });

  it("should report hasResource true/false correctly", () => {
    expect(world.hasResource(DataStore)).toBe(false);
    world.insertResource(DataStore, new Map());
    expect(world.hasResource(DataStore)).toBe(true);
  });

  it("should overwrite on second insertResource", () => {
    world.insertResource(DataStore, new Map([["x", "old"]]));
    world.insertResource(DataStore, new Map([["y", "new"]]));

    const r = world.resource(DataStore);
    expect(r!.get("x")).toBeUndefined();
    expect(r!.get("y")).toBe("new");
  });

  it("should return undefined after removeResource", () => {
    world.insertResource(DataStore, new Map());
    world.removeResource(DataStore);
    expect(world.resource(DataStore)).toBeUndefined();
  });

  it("should not throw when removing a non-existent resource", () => {
    expect(() => world.removeResource(DataStore)).not.toThrow();
  });

  it("should coexist with defineComponent-based resources", () => {
    const CompRes = defineComponent("compRes", { val: 1 });
    const ResOnly = defineResource<{ val: number }>("resOnly");

    world.insertResource(CompRes, { val: 10 });
    world.insertResource(ResOnly, { val: 20 });

    expect(world.resource(CompRes)!.val).toBe(10);
    expect(world.resource(ResOnly)!.val).toBe(20);

    world.removeResource(CompRes);
    expect(world.resource(CompRes)).toBeUndefined();
    expect(world.resource(ResOnly)!.val).toBe(20);
  });

  // ── resourceChanged — framework-managed tick tracking ──

  it("resourceChanged should return true on first access (no prior observation)", () => {
    world.insertResource(DataStore, new Map());
    expect(world.resourceChanged(DataStore)).toBe(true);
  });

  it("resourceChanged should return false on second access with no intervening update", () => {
    world.insertResource(DataStore, new Map());
    world.resourceChanged(DataStore); // observe
    expect(world.resourceChanged(DataStore)).toBe(false);
  });

  it("resourceChanged should return true after insertResource updates the resource", () => {
    world.insertResource(DataStore, new Map());
    world.resourceChanged(DataStore); // observe
    world.insertResource(DataStore, new Map()); // update
    expect(world.resourceChanged(DataStore)).toBe(true);
  });

  it("resourceChanged should return true after markResourceChanged", () => {
    world.insertResource(DataStore, new Map());
    world.resourceChanged(DataStore); // observe
    world.markResourceChanged(DataStore); // bump tick
    expect(world.resourceChanged(DataStore)).toBe(true);
  });

  it("resourceChanged is per-observer — different observers have independent state", () => {
    world.insertResource(DataStore, new Map());

    world.setCurrentObserver("SysA");
    expect(world.resourceChanged(DataStore)).toBe(true);  // SysA first access
    expect(world.resourceChanged(DataStore)).toBe(false); // SysA second access

    world.setCurrentObserver("SysB");
    expect(world.resourceChanged(DataStore)).toBe(true);  // SysB first access
    expect(world.resourceChanged(DataStore)).toBe(false); // SysB second access
  });
});

// ═══════════════════════════════════════════════════════════
// Query archetype 缓存（Bevy QueryState 等价）——增量匹配正确性
// ═══════════════════════════════════════════════════════════

describe("Query archetype cache", () => {
  it("稳态：重复 query 结果一致（缓存命中不改变语义）", () => {
    const w = new World();
    const a = w.spawn([Position.create({ x: 1 }), Velocity.create({ dx: 1 })]);
    const b = w.spawn([Position.create({ x: 2 }), Velocity.create({ dx: 2 })]);
    expect(w.query(Position, Velocity).entities()).toEqual([a, b]);
    expect(w.query(Position, Velocity).entities()).toEqual([a, b]);
  });

  it("增量：新增 archetype 后 query 包含新实体（Bevy update_archetypes）", () => {
    const w = new World();
    w.spawn([Position.create({ x: 1 }), Velocity.create({ dx: 1 })]);
    const before = w.query(Position, Velocity).entities().length; // 建立缓存
    // 新 archetype：Position+Velocity+Health
    const c = w.spawn([Position.create({ x: 3 }), Velocity.create({ dx: 3 }), Health.create({ value: 10 })]);
    const after = w.query(Position, Velocity).entities();
    expect(after).toContain(c);
    expect(after.length).toBe(before + 1);
  });

  it("增量 + Without：新增 archetype 含被排除组件则不加入候选", () => {
    const w = new World();
    w.spawn([Position.create(), Velocity.create()]);
    w.query(Position).filter(Without(Tag)).entities(); // 建立缓存
    const excluded = w.spawn([Position.create(), Tag.create({ name: "t" })]);
    expect(w.query(Position).filter(Without(Tag)).entities()).not.toContain(excluded);
    // 不带 Without 的普通 query 应包含
    expect(w.query(Position).entities()).toContain(excluded);
  });

  it("缓存按查询独立：不同 factories 增量互不干扰", () => {
    const w = new World();
    w.spawn([Position.create(), Velocity.create(), Health.create()]);
    w.query(Position).entities(); // 缓存 A
    w.query(Position, Velocity).entities(); // 缓存 B
    const t = w.spawn([Position.create(), Tag.create({ name: "t" })]);
    expect(w.query(Position).entities()).toContain(t); // A 增量加入
    expect(w.query(Position, Velocity).entities()).not.toContain(t); // B 不加入（缺 Velocity）
  });

  it("With 增量：新增 archetype 满足 With 则加入", () => {
    const w = new World();
    w.spawn([Position.create(), Velocity.create()]);
    w.query(Position).filter(With(Tag)).entities(); // 建立缓存（当前无匹配）
    const ok = w.spawn([Position.create(), Tag.create({ name: "y" })]);
    const plain = w.spawn([Position.create()]); // 不含 Tag——With(Tag) 必须排除
    const withTag = w.query(Position).filter(With(Tag)).entities();
    expect(withTag).toContain(ok);
    expect(withTag).not.toContain(plain);
  });
});

// ═══════════════════════════════════════════════════════════
// Query 缓存大世界测试（>16 archetype 强制走缓存路径）——
// 变异测试发现：小世界走快速路径，缓存增量逻辑未被覆盖
// ═══════════════════════════════════════════════════════════

const qvarComps: ReturnType<typeof defineComponent>[] = [];
for (let i = 0; i < 20; i++) qvarComps.push(defineComponent(`qvar${i}`, { v: 0 }));

function bigWorld(): World {
  const w = new World();
  for (let i = 0; i < 20; i++) {
    w.spawn([Position.create({ x: i }), qvarComps[i].create({ v: 1 })]);
  }
  return w;
}

describe("Query cache large-world (强制缓存路径)", () => {
  it("大世界：增量 Without 排除——新增含 Tag 的 archetype 不加入候选", () => {
    const w = bigWorld();
    w.query(Position).filter(Without(Tag)).entities(); // 建立缓存（20 archetype > 16）
    const excluded = w.spawn([Position.create(), Tag.create({ name: "t" })]);
    expect(w.query(Position).filter(Without(Tag)).entities()).not.toContain(excluded);
    expect(w.query(Position).entities()).toContain(excluded);
  });

  it("大世界：增量 With 纳入（With 组件已有 archetype 时缓存生效）", () => {
    const w = bigWorld();
    // 先让 Tag 有 archetype → With(Tag) 缓存可建立（computeCandidates 非 null）
    const base = w.spawn([Position.create(), Tag.create({ name: "base" })]);
    const before = w.query(Position).filter(With(Tag)).entities();
    expect(before).toContain(base);
    const ok = w.spawn([Position.create(), Tag.create({ name: "y" })]);
    const plain = w.spawn([Position.create()]); // 不含 Tag——With(Tag) 必须排除
    const withTag = w.query(Position).filter(With(Tag)).entities();
    expect(withTag).toContain(ok);
    expect(withTag).not.toContain(plain);
  });

  it("大世界：不同 Without 缓存隔离（cacheKey 含 without）", () => {
    const w = bigWorld();
    // 两个不同 Without 查询建立各自缓存
    const noTag = w.query(Position).filter(Without(Tag)).entities();
    const noHealth = w.query(Position).filter(Without(Health)).entities();
    // 新增含 Tag 的 archetype：应只影响 noTag（排除），noHealth 应包含
    const e = w.spawn([Position.create(), Tag.create({ name: "z" })]);
    expect(w.query(Position).filter(Without(Tag)).entities()).not.toContain(e);
    expect(w.query(Position).filter(Without(Health)).entities()).toContain(e);
    expect(noTag.length).toBeGreaterThan(0);
    expect(noHealth.length).toBeGreaterThan(0);
  });

  it("大世界：增量加入新 archetype（普通查询）", () => {
    const w = bigWorld();
    const before = w.query(Position).entities().length; // 20
    const e = w.spawn([Position.create(), Health.create({ value: 1 })]);
    expect(w.query(Position).entities()).toContain(e);
    expect(w.query(Position).entities().length).toBe(before + 1);
  });
});
