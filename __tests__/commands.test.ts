// Commands + EntityCommands unit tests — Bevy-style deferred mutation queue
//
// Covers: spawn(0/1/N), EntityCommands chain, entity() operations,
// resource commands, ordering, pre-reserved entity behavior

import { describe, it, expect, beforeEach } from "vitest";
import { World, defineComponent, defineResource, Commands } from "@learnvis/ecs";
import type { Entity, ComponentFactory } from "@learnvis/ecs";

// ── Test components ──

const Position = defineComponent("position", { x: 0, y: 0 });
const Velocity = defineComponent("velocity", { dx: 0, dy: 0 });
const Health = defineComponent("health", { value: 100 });
const Tag = defineComponent("tag", { name: "" });
const ScoreRes = defineResource<{ points: number }>("score");

// ── Helpers ──

function spawn(world: World, ...factories: ComponentFactory<any>[]): Entity {
  return world.spawn(factories.map((f) => f.create()));
}

function countEntities(world: World): number {
  return world.query(Position).entities().length;
}

// ═══════════════════════════════════════════════════════════
// Commands.spawn()
// ═══════════════════════════════════════════════════════════

describe("Commands.spawn", () => {
  let world: World;

  beforeEach(() => { world = new World(); });

  it("spawn with zero components — entity reserved, valid id, not queryable", () => {
    const cmd = new Commands(world);
    const e = cmd.spawn();
    expect(e.id()).toBeTypeOf("number");
    expect(world.isAlive(e.id())).toBe(true);
    // Not queryable before flush — no archetype entry
    expect(world.query(Position).entities().length).toBe(0);
    world.applyCommands();
    // Still not queryable after flush — no components
    expect(world.query(Position).entities().length).toBe(0);
    expect(world.isAlive(e.id())).toBe(true);
  });

  it("spawn with one component — entity exists after flush", () => {
    const cmd = new Commands(world);
    const e = cmd.spawn(Position({ x: 3, y: 4 }));
    world.applyCommands();
    const pos = world.getComponent(e.id(), Position);
    expect(pos).toEqual({ x: 3, y: 4 });
    expect(countEntities(world)).toBe(1);
  });

  it("spawn with multiple components — all present after flush", () => {
    const cmd = new Commands(world);
    const e = cmd.spawn(Position({ x: 1 }), Velocity({ dx: 0.5 }));
    world.applyCommands();
    expect(world.getComponent(e.id(), Position)).toEqual({ x: 1, y: 0 });
    expect(world.getComponent(e.id(), Velocity)).toEqual({ dx: 0.5, dy: 0 });
  });

  it("spawn returns EntityCommands — .id() valid before flush", () => {
    const cmd = new Commands(world);
    const e = cmd.spawn(Position());
    const id = e.id();
    expect(id).toBeTypeOf("number");
    expect(world.isAlive(id)).toBe(true);
  });

  it("spawn entity not queryable before flush", () => {
    const cmd = new Commands(world);
    cmd.spawn(Position());
    // position query should be empty before applyCommands
    expect(countEntities(world)).toBe(0);
    world.applyCommands();
    expect(countEntities(world)).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════
// EntityCommands fluent API
// ═══════════════════════════════════════════════════════════

describe("EntityCommands fluent", () => {
  let world: World;

  beforeEach(() => { world = new World(); });

  it("spawn(A).insert(B) — entity has A+B after flush", () => {
    const cmd = new Commands(world);
    cmd.spawn(Position({ x: 1 })).insert(Velocity({ dx: 2 }));
    world.applyCommands();
    expect(countEntities(world)).toBe(1);
    const e = world.query(Position, Velocity).first()!;
    const vel = world.getComponent(e, Velocity);
    expect(vel).toEqual({ dx: 2, dy: 0 });
  });

  it("chained inserts — spawn(A).insert(B).insert(C)", () => {
    const cmd = new Commands(world);
    cmd.spawn(Position()).insert(Velocity()).insert(Health({ value: 50 }));
    world.applyCommands();
    const e = world.query(Position, Velocity, Health).first()!;
    expect(world.getComponent(e, Health)).toEqual({ value: 50 });
  });

  it("spawn(A).remove(A) — entity has no components after flush", () => {
    const cmd = new Commands(world);
    cmd.spawn(Position()).remove(Position);
    world.applyCommands();
    expect(countEntities(world)).toBe(0);
  });

  it("spawn(A).insert(B).remove(A) — entity only has B", () => {
    const cmd = new Commands(world);
    cmd.spawn(Position()).insert(Velocity()).remove(Position);
    world.applyCommands();
    expect(countEntities(world)).toBe(0); // Position removed
    const e = world.query(Velocity).first()!;
    expect(world.hasComponent(e, Position)).toBe(false);
    expect(world.hasComponent(e, Velocity)).toBe(true);
  });

  it("spawn(A).despawn() — entity dead after flushDestroyed", () => {
    const cmd = new Commands(world);
    const e = cmd.spawn(Position());
    const id = e.id();
    e.despawn();
    world.applyCommands();
    world.flushDestroyed();
    expect(world.isAlive(id)).toBe(false);
  });

  it(".insert() returns this for chaining", () => {
    const cmd = new Commands(world);
    const result = cmd.spawn(Position()).insert(Velocity());
    expect(result).toBeDefined();
    expect(result.id()).toBeTypeOf("number");
  });

  it(".remove() returns this for chaining", () => {
    const cmd = new Commands(world);
    const e = spawn(world, Position, Velocity);
    const result = cmd.entity(e).remove(Velocity);
    expect(result.id()).toBe(e);
  });
});

// ═══════════════════════════════════════════════════════════
// Commands.entity() — existing entity operations
// ═══════════════════════════════════════════════════════════

describe("Commands.entity", () => {
  let world: World;

  beforeEach(() => { world = new World(); });

  it("entity(e).insert(C) — component added after flush", () => {
    const e = spawn(world, Position);
    expect(world.hasComponent(e, Velocity)).toBe(false);
    const cmd = new Commands(world);
    cmd.entity(e).insert(Velocity({ dx: 1 }));
    world.applyCommands();
    expect(world.hasComponent(e, Velocity)).toBe(true);
  });

  it("entity(e).remove(factory) — component removed after flush", () => {
    const e = spawn(world, Position, Velocity);
    const cmd = new Commands(world);
    cmd.entity(e).remove(Velocity);
    world.applyCommands();
    expect(world.hasComponent(e, Velocity)).toBe(false);
  });

  it("entity(e).despawn() — entity destroyed after flushDestroyed", () => {
    const e = spawn(world, Position);
    const cmd = new Commands(world);
    cmd.entity(e).despawn();
    world.applyCommands();
    world.flushDestroyed();
    expect(world.isAlive(e)).toBe(false);
  });

  it("entity(dead).insert() — no-op (setComponent has isAlive check)", () => {
    const e = spawn(world, Position);
    world.destroy(e);
    world.flushDestroyed();
    expect(world.isAlive(e)).toBe(false);
    const cmd = new Commands(world);
    // Should not throw
    cmd.entity(e).insert(Velocity());
    world.applyCommands();
  });
});

// ═══════════════════════════════════════════════════════════
// Resource commands
// ═══════════════════════════════════════════════════════════

describe("Commands resource", () => {
  let world: World;

  beforeEach(() => { world = new World(); });

  it("insertResource — resource present after flush", () => {
    const cmd = new Commands(world);
    cmd.insertResource(ScoreRes, { points: 100 });
    world.applyCommands();
    expect(world.resource(ScoreRes)).toEqual({ points: 100 });
  });

  it("removeResource — resource absent after flush", () => {
    world.insertResource(ScoreRes, { points: 50 });
    const cmd = new Commands(world);
    cmd.removeResource(ScoreRes);
    world.applyCommands();
    expect(world.hasResource(ScoreRes)).toBe(false);
  });

  it("insertResource then removeResource in same batch", () => {
    const cmd = new Commands(world);
    cmd.insertResource(ScoreRes, { points: 10 });
    cmd.removeResource(ScoreRes);
    world.applyCommands();
    expect(world.hasResource(ScoreRes)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// Command ordering + edge cases
// ═══════════════════════════════════════════════════════════

describe("Commands ordering + edge cases", () => {
  let world: World;

  beforeEach(() => { world = new World(); });

  it("spawn then entity commands on same entity — correct order", () => {
    const cmd = new Commands(world);
    const eid = cmd.spawn(Position({ x: 1 })).id();
    cmd.entity(eid).insert(Velocity({ dx: 2 }));
    cmd.entity(eid).insert(Health({ value: 100 }));
    world.applyCommands();
    expect(world.getComponent(eid, Position)).toEqual({ x: 1, y: 0 });
    expect(world.getComponent(eid, Velocity)).toEqual({ dx: 2, dy: 0 });
    expect(world.getComponent(eid, Health)).toEqual({ value: 100 });
  });

  it("multiple spawns interleaved — each has correct components", () => {
    const cmd = new Commands(world);
    const a = cmd.spawn(Position({ x: 1 }));
    const b = cmd.spawn(Position({ x: 2 }));
    a.insert(Tag({ name: "a" }));
    b.insert(Tag({ name: "b" }));
    world.applyCommands();
    const entities = world.query(Position, Tag).entities();
    expect(entities.length).toBe(2);
  });

  it("commands don't execute before applyCommands", () => {
    const cmd = new Commands(world);
    cmd.spawn(Position());
    // Before flush
    expect(world.query(Position).entities().length).toBe(0);
  });

  it("pre-reserved entity invisible to queries before flush", () => {
    const cmd = new Commands(world);
    const e = cmd.spawn(Position());
    // Is alive but has no archetype entry
    expect(world.isAlive(e.id())).toBe(true);
    expect(world.getComponent(e.id(), Position)).toBeUndefined();
  });

  it("spawn then despawn in same batch — never queryable", () => {
    const cmd = new Commands(world);
    cmd.spawn(Position()).despawn();
    world.applyCommands();
    world.flushDestroyed();
    expect(world.query(Position).entities().length).toBe(0);
  });

  it("EntityCommands.id() survives across flush boundaries", () => {
    const cmd = new Commands(world);
    const e = cmd.spawn(Position());
    const id = e.id();
    world.applyCommands();
    expect(world.isAlive(id)).toBe(true);
    expect(id).toBe(e.id()); // same reference across flush
  });

  it("empty Commands — no crash", () => {
    // No operations queued
    new Commands(world);
    world.applyCommands(); // should not throw
    world.flushDestroyed(); // should not throw
  });

  it("Commands.entity() works after synchronous world.spawn", () => {
    const e = spawn(world, Position);
    const cmd = new Commands(world);
    cmd.entity(e).insert(Velocity({ dx: 1 }));
    world.applyCommands();
    expect(world.hasComponent(e, Velocity)).toBe(true);
  });
});
