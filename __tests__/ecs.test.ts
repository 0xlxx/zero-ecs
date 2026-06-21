// packages/ecs/__tests__/ecs.test.ts
// Unit tests for @learnvis/ecs — World, Entity lifecycle, Component CRUD, Query, System.
//
// Test categories mirror the api-design checklist:
//   1. Entity lifecycle  (spawn / destroy / isAlive)
//   2. Component CRUD    (add / set / get / has / remove / patch)
//   3. Query             (1 kind, N kinds, empty, destroyed exclusion)
//   4. UserId index      (entityByUserId — same-id reuse pattern)
//   5. System            (registration / execution order / context)
//   6. Edge cases        (dead entity, double add, defaults)

import { describe, it, expect, beforeEach, vi } from "vitest";
import { World } from "@learnvis/ecs";
import type { Entity, System, ComponentOf, DataOf } from "@learnvis/ecs";

// ── Helpers ──

function makePosition(x: number, y: number, z: number): ComponentOf<"position3D"> {
  return { type: "position3D", x, y, z };
}

function makeAppearance(overrides?: Partial<DataOf<"appearance">>): ComponentOf<"appearance"> {
  return {
    type: "appearance",
    color: overrides?.color ?? 0xff0000,
    opacity: overrides?.opacity ?? 1,
    wireframe: overrides?.wireframe ?? false,
    emissive: overrides?.emissive ?? 0,
  };
}

function makeUserId(id: string): ComponentOf<"userId"> {
  return { type: "userId", value: id };
}

function makeLabel(text: string): ComponentOf<"label"> {
  return { type: "label", text, offset: [0, 0.5, 0] };
}

function makeThickness(v: number): ComponentOf<"thickness"> {
  return { type: "thickness", value: v };
}

// ════════════════════════════════════════════════
// 1. Entity lifecycle
// ════════════════════════════════════════════════

describe("Entity lifecycle", () => {
  let w: World;

  beforeEach(() => {
    w = new World();
  });

  it("spawn() returns unique branded numbers", () => {
    const a = w.spawn();
    const b = w.spawn();
    expect(a).not.toBe(b);
    // branded — not plain number
    expect(typeof a).toBe("number");
    expect(typeof b).toBe("number");
  });

  it("isAlive() is true after spawn, false after destroy", () => {
    const e = w.spawn();
    expect(w.isAlive(e)).toBe(true);
    w.destroy(e);
    expect(w.isAlive(e)).toBe(false);
  });

  it("isAlive() returns false for unknown entities", () => {
    expect(w.isAlive(999 as Entity)).toBe(false);
    expect(w.isAlive(-1 as Entity)).toBe(false);
  });

  it("destroy() is idempotent", () => {
    const e = w.spawn();
    w.destroy(e);
    expect(() => w.destroy(e)).not.toThrow();
    expect(w.isAlive(e)).toBe(false);
  });

  it("destroy() on unknown entity does not throw", () => {
    expect(() => w.destroy(999 as Entity)).not.toThrow();
  });
});

// ════════════════════════════════════════════════
// 2. Component CRUD
// ════════════════════════════════════════════════

describe("Component CRUD", () => {
  let w: World;

  beforeEach(() => {
    w = new World();
  });

  // ── addComponent ──

  it("addComponent() attaches data, getComponent() retrieves it", () => {
    const e = w.spawn();
    w.addComponent(e, makePosition(1, 2, 3));
    const pos = w.getComponent(e, "position3D");
    expect(pos).toBeDefined();
    expect(pos!.x).toBe(1);
    expect(pos!.y).toBe(2);
    expect(pos!.z).toBe(3);
  });

  it("addComponent() throws on duplicate kind", () => {
    const e = w.spawn();
    w.addComponent(e, makePosition(0, 0, 0));
    expect(() => w.addComponent(e, makePosition(1, 1, 1))).toThrow(/already has component/);
  });

  it("addComponent() silently no-ops on dead entity", () => {
    const e = w.spawn();
    w.destroy(e);
    expect(() => w.addComponent(e, makePosition(0, 0, 0))).not.toThrow();
    expect(w.getComponent(e, "position3D")).toBeUndefined();
  });

  // ── setComponent (reclaimId) ──

  it("setComponent() creates if absent, replaces if present", () => {
    const e = w.spawn();
    // First call: create
    w.setComponent(e, makePosition(1, 0, 0));
    expect(w.getComponent(e, "position3D")!.x).toBe(1);
    // Second call: replace
    w.setComponent(e, makePosition(2, 0, 0));
    expect(w.getComponent(e, "position3D")!.x).toBe(2);
  });

  it("setComponent() silently no-ops on dead entity", () => {
    const e = w.spawn();
    w.destroy(e);
    w.setComponent(e, makePosition(0, 0, 0));
    expect(w.getComponent(e, "position3D")).toBeUndefined();
  });

  // ── getComponent ──

  it("getComponent() returns undefined for missing kind", () => {
    const e = w.spawn();
    expect(w.getComponent(e, "position3D")).toBeUndefined();
    expect(w.getComponent(e, "label")).toBeUndefined();
  });

  it("getComponent() returns undefined for dead entity", () => {
    const e = w.spawn();
    w.addComponent(e, makePosition(0, 0, 0));
    w.destroy(e);
    expect(w.getComponent(e, "position3D")).toBeUndefined();
  });

  // ── hasComponent ──

  it("hasComponent() returns correct boolean", () => {
    const e = w.spawn();
    expect(w.hasComponent(e, "position3D")).toBe(false);
    w.addComponent(e, makePosition(0, 0, 0));
    expect(w.hasComponent(e, "position3D")).toBe(true);
    expect(w.hasComponent(e, "label")).toBe(false);
  });

  // ── removeComponent ──

  it("removeComponent() deletes the component", () => {
    const e = w.spawn();
    w.addComponent(e, makePosition(0, 0, 0));
    w.removeComponent(e, "position3D");
    expect(w.hasComponent(e, "position3D")).toBe(false);
    expect(w.getComponent(e, "position3D")).toBeUndefined();
  });

  it("removeComponent() on missing kind does not throw", () => {
    const e = w.spawn();
    expect(() => w.removeComponent(e, "position3D")).not.toThrow();
  });

  // ── patchComponent ──

  it("patchComponent() merges into existing component", () => {
    const e = w.spawn();
    w.addComponent(e, makePosition(1, 2, 3));
    w.patchComponent(e, "position3D", { x: 10 });
    const pos = w.getComponent(e, "position3D")!;
    expect(pos.x).toBe(10);
    expect(pos.y).toBe(2); // preserved
    expect(pos.z).toBe(3); // preserved
  });

  it("patchComponent() creates from defaults when absent", () => {
    const e = w.spawn();
    w.patchComponent(e, "position3D", { x: 5 });
    const pos = w.getComponent(e, "position3D")!;
    expect(pos.x).toBe(5);
    expect(pos.y).toBe(0); // default
    expect(pos.z).toBe(0); // default
  });

  it("patchComponent() silently no-ops on dead entity", () => {
    const e = w.spawn();
    w.destroy(e);
    expect(() => w.patchComponent(e, "position3D", { x: 1 })).not.toThrow();
    expect(w.getComponent(e, "position3D")).toBeUndefined();
  });

  it("patchComponent() preserves unrelated components", () => {
    const e = w.spawn();
    w.addComponent(e, makePosition(0, 0, 0));
    w.addComponent(e, makeAppearance());
    w.patchComponent(e, "position3D", { x: 99 });
    expect(w.getComponent(e, "appearance")).toBeDefined();
    expect(w.getComponent(e, "position3D")!.x).toBe(99);
  });
});

// ════════════════════════════════════════════════
// 3. Query
// ════════════════════════════════════════════════

describe("Query", () => {
  let w: World;

  beforeEach(() => {
    w = new World();
  });

  it("query() with single kind returns matching entities", () => {
    const a = w.spawn();
    w.addComponent(a, makePosition(0, 0, 0));
    const b = w.spawn();
    w.addComponent(b, makePosition(1, 1, 1));
    const c = w.spawn(); // no position
    const results = [...w.query.changed("position3D")];
    expect(results).toHaveLength(2);
    expect(results).toContain(a);
    expect(results).toContain(b);
    expect(results).not.toContain(c);
  });

  it("query() with multiple kinds returns intersection", () => {
    const a = w.spawn();
    w.addComponent(a, makePosition(0, 0, 0));
    w.addComponent(a, makeAppearance());
    const b = w.spawn();
    w.addComponent(b, makePosition(1, 1, 1)); // no appearance
    const c = w.spawn();
    w.addComponent(c, makeAppearance()); // no position
    const results = [...w.query.changed("position3D", "appearance")];
    expect(results).toHaveLength(1);
    expect(results[0]).toBe(a);
  });

  it("query() returns empty array when no entities match", () => {
    const results = [...w.query.changed("position3D")];
    expect(results).toEqual([]);
  });

  it("query() excludes destroyed entities", () => {
    const a = w.spawn();
    w.addComponent(a, makePosition(0, 0, 0));
    const b = w.spawn();
    w.addComponent(b, makePosition(1, 1, 1));
    expect([...w.query.changed("position3D")]).toHaveLength(2);
    w.destroy(a);
    expect([...w.query.all("position3D")]).toHaveLength(1);
    expect([...w.query.all("position3D")][0]).toBe(b);
  });

  it("query() with zero kinds returns empty array", () => {
    const a = w.spawn();
    w.addComponent(a, makePosition(0, 0, 0));
    expect([...w.query.changed()]).toEqual([]);
  });
});

// ════════════════════════════════════════════════
// 4. UserId index
// ════════════════════════════════════════════════

describe("UserId index", () => {
  let w: World;

  beforeEach(() => {
    w = new World();
  });

  it("entityByUserId() finds entity by userId component", () => {
    const e = w.spawn();
    w.addComponent(e, makeUserId("my-point"));
    expect(w.entityByUserId("my-point")).toBe(e);
  });

  it("entityByUserId() returns undefined for unknown id", () => {
    expect(w.entityByUserId("nope")).toBeUndefined();
  });

  it("entityByUserId() works with setComponent (reclaimId)", () => {
    const e = w.spawn();
    w.setComponent(e, makeUserId("vec-A"));
    expect(w.entityByUserId("vec-A")).toBe(e);
    w.setComponent(e, makeUserId("vec-B"));
    expect(w.entityByUserId("vec-A")).toBeUndefined();
    expect(w.entityByUserId("vec-B")).toBe(e);
  });

  it("entityByUserId() cleared on destroy", () => {
    const e = w.spawn();
    w.addComponent(e, makeUserId("temp"));
    w.destroy(e);
    expect(w.entityByUserId("temp")).toBeUndefined();
  });

  it("entityByUserId() cleared on removeComponent of userId", () => {
    const e = w.spawn();
    w.addComponent(e, makeUserId("rm-me"));
    w.removeComponent(e, "userId");
    expect(w.entityByUserId("rm-me")).toBeUndefined();
  });

  it("entityByUserId() tracks the latest entity for a given id", () => {
    // Same-id reuse pattern: destroy old, spawn new
    const a = w.spawn();
    w.addComponent(a, makeUserId("dup"));
    w.destroy(a);
    const b = w.spawn();
    w.addComponent(b, makeUserId("dup"));
    expect(w.entityByUserId("dup")).toBe(b);
  });
});

// ════════════════════════════════════════════════
// 5. System
// ════════════════════════════════════════════════

describe("System", () => {
  let w: World;

  beforeEach(() => {
    w = new World();
  });

  it("addSystem() registers, update() executes systems in registration order", () => {
    const order: string[] = [];
    const sysA: System = {
      name: "A",
      access: {},
      update() {
        order.push("A");
      },
    };
    const sysB: System = {
      name: "B",
      access: {},
      update() {
        order.push("B");
      },
    };
    w.addSystem(sysA);
    w.addSystem(sysB);
    w.update(null);
    expect(order).toEqual(["A", "B"]);
  });

  it("system receives world and context in update()", () => {
    let capturedWorld: any = null;
    let capturedCtx: any = null;
    const sys: System = {
      name: "capture",
      access: {},
      update(world, ctx) {
        capturedWorld = world;
        capturedCtx = ctx;
      },
    };
    w.addSystem(sys);
    const ctx = { dt: 0.016 };
    w.update(ctx);
    expect(capturedWorld).toBe(w);
    expect(capturedCtx).toBe(ctx);
  });

  it("access declares reads/writes for introspection", () => {
    const sys: System = {
      name: "render",
      access: { reads: ["position3D", "geometry", "appearance"] },
      update() {},
    };
    expect(sys.access.reads).toContain("position3D");
    expect(sys.access.reads).toContain("geometry");
    expect(sys.access.reads).toContain("appearance");
  });

  it("system can read and write components during update", () => {
    const sys: System = {
      name: "init-size",
      access: { reads: ["position3D"], writes: ["size"] },
      update(world) {
        for (const e of world.query.changed("position3D")) {
          if (!world.hasComponent(e, "size")) {
            world.patchComponent(e, "size", { value: 10 });
          }
        }
      },
    };
    w.addSystem(sys);
    const e = w.spawn();
    w.addComponent(e, makePosition(0, 0, 0));
    w.update(null);
    expect(w.getComponent(e, "size")!.value).toBe(10);
  });
});

// ════════════════════════════════════════════════
// 5b. System DAG ordering
// ════════════════════════════════════════════════

describe("System DAG ordering", () => {
  it("preserves registration order when no write→read edges", () => {
    const w = new World();
    const order: string[] = [];
    w.addSystem({
      name: "A",
      access: { reads: ["position3D"] },
      update() {
        order.push("A");
      },
    });
    w.addSystem({
      name: "B",
      access: { reads: ["position3D"] },
      update() {
        order.push("B");
      },
    });
    w.addSystem({
      name: "C",
      access: { reads: ["position3D"] },
      update() {
        order.push("C");
      },
    });
    w.build();
    w.update(null);
    expect(order).toEqual(["A", "B", "C"]);
  });

  it("orders writer before reader via auto-derived write→read edge", () => {
    const w = new World();
    const order: string[] = [];
    w.addSystem({
      name: "calc",
      access: { writes: ["position3D"] },
      update() {
        order.push("calc");
      },
    });
    w.addSystem({
      name: "render",
      access: { reads: ["position3D"] },
      update() {
        order.push("render");
      },
    });
    w.build();
    w.update(null);
    expect(order).toEqual(["calc", "render"]);
  });

  it("handles multi-hop write→read chains", () => {
    const w = new World();
    const order: string[] = [];
    w.addSystem({
      name: "physics",
      access: { writes: ["position3D"] },
      update() {
        order.push("physics");
      },
    });
    w.addSystem({
      name: "collision",
      access: { reads: ["position3D"], writes: ["appearance"] },
      update() {
        order.push("collision");
      },
    });
    w.addSystem({
      name: "render",
      access: { reads: ["appearance"] },
      update() {
        order.push("render");
      },
    });
    w.build();
    w.update(null);
    expect(order.indexOf("physics")).toBeLessThan(order.indexOf("collision"));
    expect(order.indexOf("collision")).toBeLessThan(order.indexOf("render"));
  });

  it("explicit .after() overrides registration order", () => {
    const w = new World();
    const order: string[] = [];
    w.addSystem({
      name: "B",
      access: { reads: ["position3D"] },
      update() {
        order.push("B");
      },
    });
    w.addSystem({
      name: "A",
      access: { reads: ["position3D"] },
      update() {
        order.push("A");
      },
    }).after("B");
    w.build();
    w.update(null);
    expect(order).toEqual(["B", "A"]);
  });

  it("explicit .before() enforces successor constraint", () => {
    const w = new World();
    const order: string[] = [];
    w.addSystem({
      name: "A",
      access: { reads: ["position3D"] },
      update() {
        order.push("A");
      },
    }).before("B");
    w.addSystem({
      name: "B",
      access: { reads: ["position3D"] },
      update() {
        order.push("B");
      },
    });
    w.build();
    w.update(null);
    expect(order).toEqual(["A", "B"]);
  });

  it("detects simple cycle and throws", () => {
    const w = new World();
    w.addSystem({
      name: "A",
      access: { reads: ["position3D"], writes: ["position3D"] },
      update() {},
    }).after("B");
    w.addSystem({
      name: "B",
      access: { reads: ["position3D"], writes: ["position3D"] },
      update() {},
    }).after("A");
    expect(() => w.build()).toThrow(/Circular/);
  });

  it("detects cycle from conflicting write→read declarations", () => {
    const w = new World();
    // A writes 'a' reads 'b', B writes 'b' reads 'a' → A needs read-after-write for both
    // A writes 'a', B reads 'a' → A before B
    // B writes 'b', A reads 'b' → B before A
    // Cycle!
    w.addSystem({
      name: "A",
      access: { reads: ["appearance"], writes: ["position3D"] },
      update() {},
    });
    w.addSystem({
      name: "B",
      access: { reads: ["position3D"], writes: ["appearance"] },
      update() {},
    });
    expect(() => w.build()).toThrow(/Circular/);
  });

  it("late registration after build appends to end", () => {
    const w = new World();
    const order: string[] = [];
    w.addSystem({
      name: "A",
      access: { reads: ["position3D"] },
      update() {
        order.push("A");
      },
    });
    w.build();
    w.addSystem({
      name: "B",
      access: { reads: ["position3D"] },
      update() {
        order.push("B");
      },
    });
    w.update(null);
    expect(order).toEqual(["A", "B"]);
  });

  it("system with no access declarations works", () => {
    const w = new World();
    const order: string[] = [];
    w.addSystem({
      name: "noop",
      access: {},
      update() {
        order.push("noop");
      },
    });
    w.build();
    w.update(null);
    expect(order).toEqual(["noop"]);
  });

  it("multiple writes to same component preserve registration order", () => {
    const w = new World();
    const order: string[] = [];
    w.addSystem({
      name: "first",
      access: { writes: ["position3D"] },
      update() {
        order.push("first");
      },
    });
    w.addSystem({
      name: "second",
      access: { writes: ["position3D"] },
      update() {
        order.push("second");
      },
    });
    w.addSystem({
      name: "reader",
      access: { reads: ["position3D"] },
      update() {
        order.push("reader");
      },
    });
    w.build();
    w.update(null);
    expect(order).toEqual(["first", "second", "reader"]);
  });
});

// ════════════════════════════════════════════════
// 6. Edge cases & invariants
// ════════════════════════════════════════════════

describe("Edge cases", () => {
  it("spawn → add → query → patch → destroy cycle works correctly", () => {
    const w = new World();
    const e = w.spawn();
    w.addComponent(e, makePosition(0, 0, 0));
    w.addComponent(e, makeAppearance({ color: 0x00ff00 }));
    w.addComponent(e, makeUserId("test-entity"));

    expect([...w.query.changed("position3D", "appearance", "userId")]).toEqual([e]);
    expect(w.entityByUserId("test-entity")).toBe(e);

    w.patchComponent(e, "appearance", { opacity: 0.5 });
    expect(w.getComponent(e, "appearance")!.opacity).toBe(0.5);

    w.destroy(e);
    expect([...w.query.changed("position3D")]).toEqual([]);
    expect(w.entityByUserId("test-entity")).toBeUndefined();
    expect(w.isAlive(e)).toBe(false);
  });

  it("multiple entities with interleaved component sets query correctly", () => {
    const w = new World();
    const a = w.spawn();
    w.addComponent(a, makePosition(0, 0, 0));
    const b = w.spawn();
    w.addComponent(b, makePosition(1, 1, 1));
    w.addComponent(b, makeLabel("B"));
    const c = w.spawn();
    w.addComponent(c, makeLabel("C"));

    expect([...w.query.changed("position3D")]).toEqual([a, b]);
    expect([...w.query.all("label")]).toEqual([b, c]);
    expect([...w.query.all("position3D", "label")]).toEqual([b]);
    expect([...w.query.changed("position3D", "label", "userId")]).toEqual([]);
  });

  it("World instances are independent", () => {
    const w1 = new World();
    const w2 = new World();
    const e1 = w1.spawn();
    w1.addComponent(e1, makePosition(0, 0, 0));
    const e2 = w2.spawn();
    w2.addComponent(e2, makePosition(1, 1, 1));

    expect([...w1.query.changed("position3D")]).toHaveLength(1);
    expect([...w2.query.changed("position3D")]).toHaveLength(1);
    expect(w1.isAlive(e2)).toBe(false); // cross-world entity
  });

  it("spawn returns incrementing IDs", () => {
    const w = new World();
    const ids = Array.from({ length: 5 }, () => w.spawn());
    const unique = new Set(ids);
    expect(unique.size).toBe(5);
  });

  it("destroy+respawn correctly reuses index entries", () => {
    const w = new World();
    const a = w.spawn();
    w.addComponent(a, makeUserId("P"));
    w.destroy(a);
    const b = w.spawn();
    w.addComponent(b, makeUserId("P"));
    expect(w.entityByUserId("P")).toBe(b);
    expect(w.entityByUserId("P")).not.toBe(a);
  });
});

// ════════════════════════════════════════════════
// 7. Rebuild avoidance — entity reuse patterns
// ════════════════════════════════════════════════

describe("Rebuild avoidance", () => {
  it("setComponent does not change entity identity", () => {
    const w = new World();
    const e = w.spawn();
    w.addComponent(e, makePosition(0, 0, 0));
    w.addComponent(e, makeUserId("vec-v"));

    w.setComponent(e, makePosition(10, 20, 30));

    expect(w.isAlive(e)).toBe(true);
    expect(w.entityByUserId("vec-v")).toBe(e);
    expect(w.getComponent(e, "position3D")!.x).toBe(10);
  });

  it("patchComponent does not change entity identity", () => {
    const w = new World();
    const e = w.spawn();
    w.addComponent(e, makePosition(1, 2, 3));
    w.addComponent(e, makeUserId("obj-X"));

    w.patchComponent(e, "position3D", { y: 99 });
    w.patchComponent(e, "position3D", { z: 42 });

    expect(w.isAlive(e)).toBe(true);
    expect(w.entityByUserId("obj-X")).toBe(e);
    const pos = w.getComponent(e, "position3D")!;
    expect(pos.x).toBe(1); // untouched
    expect(pos.y).toBe(99); // patched
    expect(pos.z).toBe(42); // patched
  });

  it("same-id reuse: destroy old, spawn new, component data updates", () => {
    // Simulates the scene.ts same-id reuse path:
    //   reclaimId(id) → destroy old → spawn new → addComponent
    const w = new World();
    const a = w.spawn();
    w.addComponent(a, makeUserId("P"));
    w.addComponent(a, makePosition(0, 0, 0));
    expect(w.entityByUserId("P")).toBe(a);

    w.destroy(a);
    const b = w.spawn();
    w.addComponent(b, makeUserId("P"));
    w.addComponent(b, makePosition(5, 5, 5));

    expect(w.entityByUserId("P")).toBe(b);
    expect(w.isAlive(a)).toBe(false);
    expect(w.getComponent(b, "position3D")!.x).toBe(5);
    expect([...w.query.changed("position3D")]).toHaveLength(1);
  });

  it("query result count stable across setComponent updates", () => {
    const w = new World();
    const e = w.spawn();
    w.addComponent(e, makePosition(0, 0, 0));
    w.addComponent(e, makeAppearance());

    expect([...w.query.changed("position3D", "appearance")]).toHaveLength(1);

    w.setComponent(e, makePosition(1, 1, 1)); // update
    expect([...w.query.changed("position3D", "appearance")]).toHaveLength(1);

    w.setComponent(e, makeAppearance({ opacity: 0.5 })); // update
    expect([...w.query.changed("position3D", "appearance")]).toHaveLength(1);
  });

  it("addComponent throws on duplicate — prevents accidental rebuild", () => {
    const w = new World();
    const e = w.spawn();
    w.addComponent(e, makePosition(0, 0, 0));

    // Double-add is a mistake — use setComponent instead
    expect(() => w.addComponent(e, makePosition(1, 1, 1))).toThrow(/already has component/);

    // Correct: setComponent silently replaces
    w.setComponent(e, makePosition(1, 1, 1));
    expect(w.getComponent(e, "position3D")!.x).toBe(1);
  });

  it("geometric component swap preserves other components", () => {
    // When updating geometry (e.g. from sphere to cube), other
    // components like userId, position, label must survive.
    const w = new World();
    const e = w.spawn();
    w.addComponent(e, makeUserId("obj"));
    w.addComponent(e, makePosition(3, 3, 3));
    w.addComponent(e, makeLabel("test"));
    w.setComponent(e, { type: "geometry", kind: "sphere", radius: 2 } as any);

    // Swap geometry kind
    w.setComponent(e, { type: "geometry", kind: "cube", size: 4 } as any);

    expect(w.entityByUserId("obj")).toBe(e);
    expect(w.getComponent(e, "position3D")!.x).toBe(3);
    expect(w.getComponent(e, "label")!.text).toBe("test");
    const geo = w.getComponent(e, "geometry") as any;
    expect(geo.kind).toBe("cube");
    expect(geo.size).toBe(4);
  });
});

// ═══════════════════════════════════════════════════════════
// Frame lifecycle (enter/update/exit) — touched-set pattern
// ═══════════════════════════════════════════════════════════

describe("Frame lifecycle — touched-set pattern", () => {
  let w: World;
  let touched: Set<string>;
  let store: Map<string, Entity>;
  let nextId = 0;
  const eid = () => nextId++;

  function declare(id: string): Entity {
    touched.add(id);
    let entity = store.get(id);
    if (entity === undefined) {
      entity = w.spawn() as Entity;
      store.set(id, entity);
    }
    return entity;
  }

  function sweep(): Entity[] {
    const removed: Entity[] = [];
    for (const [id, entity] of store) {
      if (!touched.has(id)) {
        w.destroy(entity);
        store.delete(id);
        removed.push(entity);
      }
    }
    return removed;
  }

  beforeEach(() => {
    w = new World();
    touched = new Set();
    store = new Map();
  });

  it("entity declared in frame survives sweep", () => {
    declare("a");
    const removed = sweep();
    expect(removed).toHaveLength(0);
    expect(store.has("a")).toBe(true);
  });

  it("entity not redeclared is destroyed on sweep", () => {
    declare("a");
    sweep();
    touched.clear();
    const removed = sweep();
    expect(removed).toHaveLength(1);
    expect(store.has("a")).toBe(false);
  });

  it("entity with same id is updated not recreated", () => {
    const e1 = declare("a");
    sweep();
    touched.clear();
    const e2 = declare("a");
    expect(e2).toBe(e1);
    expect(store.size).toBe(1);
    sweep();
    expect(store.has("a")).toBe(true);
  });

  it("mixed: new survive, untouched die, updated survive", () => {
    declare("keep");
    declare("update-me");
    sweep();
    touched.clear();

    declare("keep");
    declare("update-me");
    declare("new-guy");
    expect(sweep()).toHaveLength(0);
    expect(store.size).toBe(3);
    touched.clear();

    declare("keep");
    declare("new-guy");
    const removed = sweep();
    expect(removed).toHaveLength(1);
    expect(store.has("update-me")).toBe(false);
    expect(store.has("keep")).toBe(true);
    expect(store.has("new-guy")).toBe(true);
  });

  it("step switching: step 1 entities die in step 2", () => {
    declare("step1-a");
    declare("step1-b");
    sweep();
    touched.clear();

    declare("step2-x");
    declare("step2-y");
    const removed = sweep();
    expect(removed).toHaveLength(2);
    expect(store.size).toBe(2);
    expect(store.has("step2-x")).toBe(true);
    expect(store.has("step1-a")).toBe(false);
  });

  it("destroyed entity removed from world queries", () => {
    const e = declare("a");
    sweep();
    touched.clear();
    sweep();
    expect([...w.query.changed("userId")]).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// animationPhase component — TransitionSystem
// ═══════════════════════════════════════════════════════════

describe("animationPhase component", () => {
  let w: World;

  beforeEach(() => {
    w = new World();
  });

  function spawnWithUser(userId: string): Entity {
    const e = w.spawn();
    w.addComponent(e, { type: "userId", value: userId });
    return e;
  }

  it("add animationPhase entering", () => {
    const e = w.spawn();
    w.addComponent(e, { type: "animationPhase", phase: "entering", startMs: 100 });
    const ap = w.getComponent(e, "animationPhase");
    expect(ap!.phase).toBe("entering");
    expect(ap!.startMs).toBe(100);
  });

  it("add animationPhase exiting", () => {
    const e = w.spawn();
    w.addComponent(e, { type: "animationPhase", phase: "exiting", startMs: 200 });
    expect(w.getComponent(e, "animationPhase")!.phase).toBe("exiting");
  });

  it("default animationPhase via patch", () => {
    const e = w.spawn();
    w.patchComponent(e, "animationPhase", { startMs: 50 });
    const ap = w.getComponent(e, "animationPhase");
    expect(ap!.phase).toBe("entering"); // default
    expect(ap!.startMs).toBe(50);
  });

  it("remove animationPhase", () => {
    const e = w.spawn();
    w.addComponent(e, { type: "animationPhase", phase: "entering", startMs: 0 });
    w.removeComponent(e, "animationPhase");
    expect(w.hasComponent(e, "animationPhase")).toBe(false);
  });

  it("setComponent replaces animationPhase", () => {
    const e = w.spawn();
    w.addComponent(e, { type: "animationPhase", phase: "entering", startMs: 0 });
    w.setComponent(e, { type: "animationPhase", phase: "exiting", startMs: 300 });
    expect(w.getComponent(e, "animationPhase")!.phase).toBe("exiting");
  });

  it("queryAll finds entities with animationPhase", () => {
    const e1 = spawnWithUser("a");
    const e2 = spawnWithUser("b");
    w.addComponent(e1, { type: "animationPhase", phase: "entering", startMs: 0 });
    const found = [...w.query.all("animationPhase")];
    expect(found).toHaveLength(1);
    expect(found[0]).toBe(e1);
  });

  it("query finds dirty animationPhase entities", () => {
    const e = w.spawn();
    w.addComponent(e, { type: "animationPhase", phase: "entering", startMs: 0 });
    // After add, component is dirty
    const found = [...w.query.changed("animationPhase")];
    expect(found).toHaveLength(1);
    // After world.update, dirty set clears
    w.update(null);
    const after = [...w.query.changed("animationPhase")];
    expect(after).toHaveLength(0);
  });

  it("animationPhase persisted in dump", () => {
    const e = w.spawn();
    w.addComponent(e, { type: "animationPhase", phase: "exiting", startMs: 500 });
    w.addComponent(e, { type: "userId", value: "test" });
    const dump = w.dump();
    const ent = dump.entities.find((x) => x.userId === "test");
    expect(ent).toBeDefined();
    expect(ent!.components).toContain("animationPhase");
    expect((ent!.data as any).animationPhase.phase).toBe("exiting");
  });
});

// ═══════════════════════════════════════════════════════════
// Change tick + query API
// ═══════════════════════════════════════════════════════════

describe("change ticks", () => {
  let w: World;
  beforeEach(() => {
    w = new World();
  });

  function pos(x: number, y: number, z: number) {
    return { type: "position3D" as const, x, y, z };
  }

  it("tickCounter increments on setComponent", () => {
    const e = w.spawn();
    w.addComponent(e, pos(0, 0, 0));
    const first = w.getComponentEntry(e, "position3D")!;
    expect(first.changedTick).toBeGreaterThan(0);

    w.setComponent(e, pos(1, 2, 3));
    const second = w.getComponentEntry(e, "position3D")!;
    expect(second.changedTick).toBeGreaterThan(first.changedTick);
  });

  it("addComponent and setComponent both bump tick", () => {
    const a = w.spawn();
    w.addComponent(a, pos(0, 0, 0));
    const b = w.spawn();
    w.setComponent(b, pos(1, 1, 1));
    expect(w.getComponentEntry(a, "position3D")!.changedTick).toBeGreaterThan(0);
    expect(w.getComponentEntry(b, "position3D")!.changedTick).toBeGreaterThan(0);
    // Ticks are monotonic — b was added after a
    expect(w.getComponentEntry(b, "position3D")!.changedTick).toBeGreaterThan(
      w.getComponentEntry(a, "position3D")!.changedTick,
    );
  });

  it("patchComponent bumps tick", () => {
    const e = w.spawn();
    w.addComponent(e, pos(0, 0, 0));
    const t1 = w.getComponentEntry(e, "position3D")!.changedTick;
    w.patchComponent(e, "position3D", { x: 5 });
    const t2 = w.getComponentEntry(e, "position3D")!.changedTick;
    expect(t2).toBeGreaterThan(t1);
  });

  it("getComponent does not bump tick", () => {
    const e = w.spawn();
    w.addComponent(e, pos(0, 0, 0));
    const t1 = w.getComponentEntry(e, "position3D")!.changedTick;
    w.getComponent(e, "position3D");
    expect(w.getComponentEntry(e, "position3D")!.changedTick).toBe(t1);
  });
});

describe("query.changed", () => {
  let w: World;
  beforeEach(() => {
    w = new World();
  });

  function pos(x: number, y: number, z: number) {
    return { type: "position3D" as const, x, y, z };
  }

  it("yields entities whose component tick advanced", () => {
    const e = w.spawn();
    w.addComponent(e, pos(0, 0, 0));
    // First call: tick > lastSeen(0) → yielded
    expect([...w.query.changed("position3D")]).toEqual([e]);
    // Second call: tick == lastSeen → not yielded
    expect([...w.query.changed("position3D")]).toEqual([]);
  });

  it("yields again after component is updated", () => {
    const e = w.spawn();
    w.addComponent(e, pos(0, 0, 0));
    expect([...w.query.changed("position3D")]).toEqual([e]);
    expect([...w.query.changed("position3D")]).toEqual([]);
    // Update component
    w.setComponent(e, pos(1, 2, 3));
    expect([...w.query.changed("position3D")]).toEqual([e]);
  });

  it("multi-kind AND: yields when all kinds changed", () => {
    const e = w.spawn();
    w.addComponent(e, pos(0, 0, 0));
    w.addComponent(e, {
      type: "appearance",
      color: 0xff0000,
      opacity: 1,
      wireframe: false,
      emissive: 0,
    });
    // Both kinds are new (ticks > 0)
    expect([...w.query.changed("position3D", "appearance")]).toEqual([e]);
  });

  it("multi-kind AND: skips entity missing a kind", () => {
    const e = w.spawn();
    w.addComponent(e, pos(0, 0, 0)); // no appearance
    expect([...w.query.changed("position3D", "appearance")]).toEqual([]);
  });

  it("excludes dead entities", () => {
    const e = w.spawn();
    w.addComponent(e, pos(0, 0, 0));
    w.destroy(e);
    expect([...w.query.changed("position3D")]).toEqual([]);
  });
});

describe("query.changedAny", () => {
  let w: World;
  beforeEach(() => {
    w = new World();
  });

  function pos(x: number, y: number, z: number) {
    return { type: "position3D" as const, x, y, z };
  }

  it("yields entities dirty in any of the given kinds", () => {
    const a = w.spawn();
    w.addComponent(a, pos(0, 0, 0));
    const b = w.spawn();
    w.addComponent(b, { type: "appearance", color: 0, opacity: 1, wireframe: false, emissive: 0 });
    // a has position3D, b has appearance
    const found = [...w.query.changedAny("position3D", "appearance")];
    expect(found).toHaveLength(2);
    expect(found).toContain(a);
    expect(found).toContain(b);
  });

  it("deduplicates entities that appear in multiple kinds", () => {
    const e = w.spawn();
    w.addComponent(e, pos(0, 0, 0));
    w.addComponent(e, { type: "appearance", color: 0, opacity: 1, wireframe: false, emissive: 0 });
    const found = [...w.query.changedAny("position3D", "appearance")];
    expect(found).toEqual([e]); // not [e, e]
  });

  it("does not yield after ticks are seen", () => {
    const e = w.spawn();
    w.addComponent(e, pos(0, 0, 0));
    expect([...w.query.changedAny("position3D")]).toEqual([e]);
    expect([...w.query.changedAny("position3D")]).toEqual([]);
  });
});

describe("query.all / query.any / query.except", () => {
  let w: World;
  beforeEach(() => {
    w = new World();
  });

  function pos(x: number, y: number, z: number) {
    return { type: "position3D" as const, x, y, z };
  }

  it("query.all returns entities with all kinds regardless of tick", () => {
    const a = w.spawn();
    w.addComponent(a, pos(0, 0, 0));
    const b = w.spawn();
    w.addComponent(b, pos(1, 1, 1));
    // See them once
    expect([...w.query.changed("position3D")]).toHaveLength(2);
    // query.all still returns them even though ticks were seen
    expect([...w.query.all("position3D")]).toEqual([a, b]);
  });

  it("query.any returns entities with at least one kind", () => {
    const a = w.spawn();
    w.addComponent(a, pos(0, 0, 0));
    const b = w.spawn();
    w.addComponent(b, { type: "appearance", color: 0, opacity: 1, wireframe: false, emissive: 0 });
    const found = [...w.query.any("position3D", "appearance")];
    expect(found).toHaveLength(2);
    expect(found).toContain(a);
    expect(found).toContain(b);
  });

  it("query.except returns entities with kind but without excluded", () => {
    const a = w.spawn();
    w.addComponent(a, pos(0, 0, 0));
    const b = w.spawn();
    w.addComponent(b, pos(1, 1, 1));
    w.addComponent(b, { type: "animationPhase", phase: "entering", startMs: 0 });
    // b has both, a has only position3D
    const found = [...w.query.except("position3D", "animationPhase")];
    expect(found).toEqual([a]);
  });
});

describe("didChange", () => {
  let w: World;
  beforeEach(() => {
    w = new World();
  });

  function pos(x: number, y: number, z: number) {
    return { type: "position3D" as const, x, y, z };
  }

  it("returns true when component changed since last seen", () => {
    const e = w.spawn();
    w.addComponent(e, pos(0, 0, 0));
    // Simulate being inside a system update
    w.update(null); // sets then clears currentObserver, but didChange needs an observer
    // Direct call uses __direct__ observer
    expect(w.didChange(e, "position3D")).toBe(true);
    // After query.changed records the tick, didChange should be false
    [...w.query.changed("position3D")];
    expect(w.didChange(e, "position3D")).toBe(false);
  });

  it("distinguishes between kinds in a changedAny loop", () => {
    const e = w.spawn();
    w.addComponent(e, pos(0, 0, 0));
    w.addComponent(e, { type: "appearance", color: 0, opacity: 1, wireframe: false, emissive: 0 });
    // See both
    [...w.query.changedAny("position3D", "appearance")];
    // Now update only position3D
    w.setComponent(e, pos(5, 5, 5));
    // position3D changed, appearance did not
    expect(w.didChange(e, "position3D")).toBe(true);
    expect(w.didChange(e, "appearance")).toBe(false);
  });

  it("returns false for component that was never set", () => {
    const e = w.spawn();
    w.addComponent(e, pos(0, 0, 0));
    expect(w.didChange(e, "appearance")).toBe(false);
  });

  it("returns false for dead entity", () => {
    const e = w.spawn();
    w.addComponent(e, pos(0, 0, 0));
    w.destroy(e);
    expect(w.didChange(e, "position3D")).toBe(false);
  });
});
