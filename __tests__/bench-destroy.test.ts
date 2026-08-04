// packages/ecs/__tests__/bench-destroy.test.ts
// Micro-benchmarks: destroy → flushDestroyed → drainKilled chain.
// Run with: pnpm vitest run packages/ecs/__tests__/bench-destroy.test.ts

import { describe, it, expect } from "vitest";
import { World, defineComponent, type Entity } from "@learnvis/ecs";

const test_pos3_d = defineComponent("testPos3D", { x: 0, y: 0, z: 0 });
const test_color = defineComponent("testColor", { value: 0xe06b38 });
const test_box_geo = defineComponent("testBoxGeo", { width: 1, height: 1, depth: 1, visible: true });
const test_basic_mat = defineComponent("testBasicMat", {
  color: 0xe06b38, opacity: 1, transparent: false, wireframe: false,
  side: "front" as "front" | "back" | "double", depthTest: true, depthWrite: true,
});

function bench(label: string, fn: () => void, iterations = 1000): number {
  // Warmup
  for (let i = 0; i < 100; i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsed = performance.now() - t0;
  const avg_us = (elapsed / iterations) * 1000;
  console.log(`  ${label}: ${elapsed.toFixed(2)}ms / ${iterations} = ${avg_us.toFixed(2)}µs avg`);
  return avg_us;
}

describe("Destroy chain benchmarks", () => {

  it("isAlive() — O(1) generation comparison", () => {
    const w = new World();
    const alive = w.spawn();
    const dead = w.spawn(); w.destroy(dead);

    bench("isAlive(live)", () => { w.isAlive(alive); }, 100_000);
    bench("isAlive(dead)", () => { w.isAlive(dead); }, 100_000);
    // Unknown entity — index out of bounds on _generations, returns undefined===gen
    const fake = 0xFFFFF_FFF as typeof alive;
    bench("isAlive(unknown)", () => { w.isAlive(fake); }, 100_000);
  });

  it("destroy() — gen++ + deferred push (O(1))", () => {
    const w = new World();
    const N = 5000;
    const entities: Entity[] = [];
    for (let i = 0; i < N; i++) entities.push(w.spawn());

    bench(`destroy ${N} entities`, () => {
      for (const e of entities) w.destroy(e);
    }, 1);
  });

  it("spawn — slot allocation + gen increment", () => {
    bench("spawn (no components)", () => {
      const w = new World();
      for (let i = 0; i < 5000; i++) w.spawn();
    }, 5);
  });

  it("spawn with components — full write path", () => {
    bench("spawn + test_box_geo + test_pos3_d + test_basic_mat", () => {
      const w = new World();
      for (let i = 0; i < 1000; i++) {
        w.spawn([
          test_box_geo.create({ width: 1, height: 1, depth: 1 }),
          test_pos3_d.create({ x: i, y: 0, z: 0 }),
          test_basic_mat.create({ color: 0x58a6ff }),
        ]);
      }
    }, 2);
  });

  it("flushDestroyed — batch pool cleanup (swap-and-pop per pool)", () => {
    // Compare: 1 at a time vs all at once
    for (const N of [10, 100, 1000]) {
      const w = new World();
      const entities: Entity[] = [];
      for (let i = 0; i < N; i++) {
        const e = w.spawn([
          test_pos3_d.create({ x: i, y: 0, z: 0 }),
          test_color.create({ value: 0xff0000 }),
          test_box_geo.create({ width: 1, height: 1, depth: 1 }),
          test_basic_mat.create({ color: 0x58a6ff }),
        ]);
        entities.push(e);
      }
      for (const e of entities) w.destroy(e);

      bench(`flushDestroyed ${N} entities (${N*4} pool entries)`, () => {
        w.flushDestroyed();
      }, 1);
    }
  });

  it("drainKilled — O(killed) retrieval", () => {
    const w = new World();
    const N = 1000;
    const entities: Entity[] = [];
    for (let i = 0; i < N; i++) {
      const e = w.spawn([test_pos3_d.create({ x: i, y: 0, z: 0 })]);
      entities.push(e);
    }
    for (const e of entities) w.destroy(e);
    w.flushDestroyed();

    bench(`drainKilled (${N} killed)`, () => {
      w.drainKilled();
    }, 1);
  });

  it("end-to-end: spawn → destroy → flushDestroyed → drainKilled", () => {
    const cycles = 10;
    const N = 500;
    let total_us = 0;
    let total_entities = 0;

    for (let c = 0; c < cycles; c++) {
      const w = new World();
      const t0 = performance.now();

      // Spawn
      for (let i = 0; i < N; i++) {
        w.spawn([
          test_pos3_d.create({ x: i, y: 0, z: 0 }),
          test_color.create({ value: 0xff }),
          test_box_geo.create({ width: 1, height: 1, depth: 1 }),
          test_basic_mat.create({ color: 0x58a6ff }),
        ]);
      }

      // Destroy all
      for (const id of w.query(test_pos3_d).entities()) w.destroy(id);

      // Flush
      w.flushDestroyed();

      // Drain (simulate ThreeSyncSystem)
      const killed = w.drainKilled();
      const elapsed = performance.now() - t0;
      total_us += elapsed * 1000;
      total_entities += killed.length;
    }

    const avg_us = total_us / cycles;
    console.log(`  E2E: ${avg_us.toFixed(2)}µs avg per ${N} spawn+destroy+flush+drain cycle`);
    expect(total_entities).toBe(cycles * N);
  });

  it("query.all filtering — post-destroy entities excluded via isAlive", () => {
    // Ensure dead entities in pools are filtered by query
    const w = new World();
    const N = 500;
    for (let i = 0; i < N; i++) {
      w.spawn([
        test_pos3_d.create({ x: i, y: 0, z: 0 }),
        test_color.create({ value: 0xff }),
      ]);
    }
    // Destroy half
    const all = w.query(test_pos3_d, test_color).entities();
    for (let i = 0; i < all.length; i += 2) w.destroy(all[i]);

    // Before flushDestroyed: dead entities still in pools, query filters via isAlive
    const before = w.query(test_pos3_d, test_color).entities();
    expect(before.length).toBe(N / 2);

    w.flushDestroyed();
    const after = w.query(test_pos3_d, test_color).entities();
    expect(after.length).toBe(N / 2);
  });
});
