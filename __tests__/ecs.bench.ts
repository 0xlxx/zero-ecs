// packages/ecs/__tests__/ecs.bench.ts — ECS benchmark suite with snapshot comparison
// @ts-nocheck
// 运行: bun run packages/ecs/__tests__/ecs.bench.ts [--save]
// --save: 保存当前结果作为基线快照
// 无参数: 运行并对比上次快照

import { World, defineComponent, Changed } from "../src/index.js";
import * as fs from "node:fs";
import * as path from "node:path";

const is_bun = typeof (globalThis as any).Bun !== "undefined";
const runtime = is_bun ? `Bun ${(globalThis as any).Bun.version}` : `Node ${process.version}`;
const now: () => number = is_bun ? (globalThis as any).Bun.nanoseconds : () => performance.now() * 1e6;
const NS_TO_MS = 1e6;

// ── Components ──
const Pos   = defineComponent("bnPos",   { x: 0, y: 0, z: 0 });
const Vel   = defineComponent("bnVel",   { dx: 0, dy: 0, dz: 0 });
// Float64Column variants (interleaved SoA)
const pos_f64 = defineComponent("bnPosF64", { x: 0, y: 0, z: 0 }, { schema: { x: "float64", y: "float64", z: "float64" } });
const vel_f64 = defineComponent("bnVelF64", { dx: 0, dy: 0, dz: 0 }, { schema: { dx: "float64", dy: "float64", dz: "float64" } });
// Sparse component for mixed table+sparse benchmarks
const sparse_tag = defineComponent("bnSparseTag", { v: 0 }, { storage: "sparse" });
// Sparse Float64 — unified Column support
const sparse_f64 = defineComponent("bnSparseF64", { a: 0, b: 0, c: 0 }, { storage: "sparse", schema: { a: "float64", b: "float64", c: "float64" } });
const Hp    = defineComponent("bnHp",    { current: 100, max: 100 });
const Size  = defineComponent("bnSize",  { w: 1, h: 1 });
const Color = defineComponent("bnColor", { r: 255, g: 255, b: 255 });
const Team  = defineComponent("bnTeam",  { id: 0 });
const Atk   = defineComponent("bnAtk",   { value: 10 });
const Def   = defineComponent("bnDef",   { value: 5 });
const Alpha = defineComponent("bnAlpha", { value: 1 });
const Speed = defineComponent("bnSpeed", { value: 1 });
const Rot   = defineComponent("bnRot",   { angle: 0 });
const Scale = defineComponent("bnScale", { x: 1, y: 1 });

// ── Benchmark harness ──
interface BenchResult {
  name: string;
  throughput: number;  // M entities/s
  usPerIter: number;
}

// min-of-samples: single-sample measurements are dominated by JIT warmup noise
// (measured 3x variance on identical code). Sample repeatedly, report the min.
const SAMPLES = 5;
function bench(name: string, setup: () => { run: () => void }, N: number, iter: number): BenchResult {
  let ctx = setup();
  for (let i = 0; i < Math.max(5, iter / 2); i++) ctx.run();
  let bestElapsed = Infinity;
  for (let s = 0; s < SAMPLES; s++) {
    if (typeof (globalThis as any).Bun !== "undefined") (globalThis as any).Bun.gc(true);
    ctx = setup();
    const t0 = now();
    for (let i = 0; i < iter; i++) ctx.run();
    bestElapsed = Math.min(bestElapsed, now() - t0);
  }
  const elapsed = bestElapsed / NS_TO_MS;
  const throughput = (N * iter) / (elapsed / 1000) / 1e6;
  console.log(`  ${name.padEnd(50)} ${((elapsed/iter)*1000).toFixed(1).padStart(7)} µs/iter  ${throughput.toFixed(1).padStart(8)} M/s`);
  return { name, throughput, usPerIter: (elapsed / iter) * 1000 };
}

// ── Scenarios ──
function runAll(): BenchResult[] {
  const results: BenchResult[] = [];
  const N = 100000, iter = 100;

  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  learnvis ECS Benchmark — ${runtime.padEnd(35)}║`);
  console.log(`║  N=${N}, iter=${iter}`);
  console.log(`╚══════════════════════════════════════════════════════════════╝`);

  // ── Simple: 1 archetype, all entities identical ──
  console.log(`\n── 1. Simple: 1 archetype, 2 components ──`);

  results.push(bench("simple: forEach(Pos,Vel)", () => {
    const w = new World();
    for (let i = 0; i < N; i++) w.spawn([Pos.create({ x: i }), Vel.create({ dx: 1 })]);
    return { run() { let s = 0; w.query(Pos, Vel).forEach((p: any, v: any) => { s += p.x + v.dx; }); void s; } };
  }, N, iter));

  results.push(bench("simple: batch(Pos,Vel)", () => {
    const w = new World();
    for (let i = 0; i < N; i++) w.spawn([Pos.create({ x: i }), Vel.create({ dx: 1 })]);
    return { run() { let s = 0; w.query(Pos, Vel).batch((p: any, v: any, _e: any, c: number) => { for (let i = 0; i < c; i++) s += p[i].x + v[i].dx; }); void s; } };
  }, N, iter));

  results.push(bench("simple: entities+getComponent", () => {
    const w = new World();
    for (let i = 0; i < N; i++) w.spawn([Pos.create({ x: i }), Vel.create({ dx: 1 })]);
    return { run() { let s = 0; for (const e of w.query(Pos, Vel).entities()) { const p = w.getComponent(e, Pos); const v = w.getComponent(e, Vel); s += p!.x + v!.dx; } void s; } };
  }, N, iter));

  // ── Simple: Float64Column variants ──
  console.log(`\n── 1b. Simple: Float64Column (interleaved SoA) ──`);

  results.push(bench("simple: forEach(pos_f64,vel_f64)", () => {
    const w = new World();
    for (let i = 0; i < N; i++) w.spawn([pos_f64.create({ x: i, y: 0, z: 0 }), vel_f64.create({ dx: 1, dy: 0, dz: 0 })]);
    return { run() { let s = 0; w.query(pos_f64, vel_f64).forEach((p: any, v: any) => { s += p.x + v.dx; }); void s; } };
  }, N, iter));

  results.push(bench("simple: batch(pos_f64,vel_f64)", () => {
    const w = new World();
    for (let i = 0; i < N; i++) w.spawn([pos_f64.create({ x: i, y: 0, z: 0 }), vel_f64.create({ dx: 1, dy: 0, dz: 0 })]);
    // Float64Column batch: receives interleaved Float64Array per factory
    // pos_f64 stride=3: [x0,y0,z0, x1,y1,z1, ...] — p[off] = x, p[off+1] = y, p[off+2] = z
    // vel_f64 stride=2: [dx0,dy0, dx1,dy1, ...] — v[off] = dx
    return { run() {
      let s = 0;
      w.query(pos_f64, vel_f64).batch((p: any, v: any, _e: any, c: number) => {
        const p_stride = 3, vStride = 2;
        for (let i = 0; i < c; i++) s += p[i * p_stride] + v[i * vStride];
      });
      void s;
    } };
  }, N, iter));

  // ── Sparse mixed: table + sparse component in same query ──
  console.log(`\n── 1c. Sparse: ObjectColumn + SparseSet (table+sparse mixed) ──`);

  results.push(bench("sparse: forEach(Pos,sparse_tag)", () => {
    const w = new World();
    for (let i = 0; i < N; i++) w.spawn([Pos.create({ x: i }), sparse_tag.create({ v: 1 })]);
    return { run() { let s = 0; w.query(Pos, sparse_tag).forEach((p: any, t: any) => { s += p.x + t.v; }); void s; } };
  }, N, iter));

  results.push(bench("sparse: batch(Pos,sparse_tag)", () => {
    const w = new World();
    for (let i = 0; i < N; i++) w.spawn([Pos.create({ x: i }), sparse_tag.create({ v: 1 })]);
    return { run() { let s = 0; w.query(Pos, sparse_tag).batch((p: any, t: any, _e: any, c: number) => { for (let i = 0; i < c; i++) s += p[i].x + t[i].v; }); void s; } };
  }, N, iter));

  // ── Sparse Float64: SparseSet backed by Float64Column ──
  console.log(`\n── 1d. Sparse Float64: SparseSet + Float64Column ──`);

  results.push(bench("sparseF64: forEach(Pos,sparse_f64)", () => {
    const w = new World();
    for (let i = 0; i < N; i++) w.spawn([Pos.create({ x: i }), sparse_f64.create({ a: i, b: 0, c: 0 })]);
    return { run() { let s = 0; w.query(Pos, sparse_f64).forEach((p: any, s64: any) => { s += p.x + s64.a; }); void s; } };
  }, N, iter));

  results.push(bench("sparseF64: batch(Pos,sparse_f64)", () => {
    const w = new World();
    for (let i = 0; i < N; i++) w.spawn([Pos.create({ x: i }), sparse_f64.create({ a: i, b: 0, c: 0 })]);
    // Sparse batch receives Record[] per entity (SparseSet order ≠ archetype order)
    return { run() { let s = 0; w.query(Pos, sparse_f64).batch((p: any, s64: any, _e: any, c: number) => { for (let i = 0; i < c; i++) s += p[i].x + s64[i].a; }); void s; } };
  }, N, iter));

  // ── Realistic: 10 archetypes ──
  console.log(`\n── 2. Realistic: 10 archetypes, 20 component types ──`);

  const ARCHETYPES: string[][] = [
    ["Pos","Vel","Hp","Atk","Def","Speed","Size","Color","Team"],
    ["Pos","Vel","Hp","Atk","Def","Speed","Size","Color"],
    ["Pos","Vel","Size","Color","Alpha","Speed","Rot","Scale"],
    ["Pos","Vel","Atk","Def","Team"],
    ["Pos","Size","Color","Alpha","Scale","Rot"],
    ["Pos","Vel","Hp","Speed","Atk","Team","Color"],
    ["Pos","Vel","Size","Color","Alpha"],
    ["Pos","Vel","Hp","Size","Color","Atk","Def","Speed","Team","Alpha"],
    ["Pos","Color","Size","Alpha","Rot"],
    ["Pos","Vel","Hp","Atk","Team","Size"],
  ];
  const LV_MAP: Record<string, any> = { Pos, Vel, Hp, Size, Color, Team, Atk, Def, Alpha, Speed, Rot, Scale };
  const ents_per_arch = Math.floor(N / ARCHETYPES.length);

  function spawn_realistic(w: World) {
    for (const arch of ARCHETYPES) {
      for (let i = 0; i < ents_per_arch; i++) {
        const comps = arch.map(name => {
          const f = LV_MAP[name];
          if (name === "Pos") return f.create({ x: i, y: 0, z: 0 });
          if (name === "Vel") return f.create({ dx: 1, dy: 0, dz: 0 });
          return f.create();
        });
        w.spawn(comps);
      }
    }
  }

  results.push(bench("real: forEach(Pos,Vel)", () => {
    const w = new World(); spawn_realistic(w);
    return { run() { let s = 0; w.query(Pos, Vel).forEach((p: any, v: any) => { s += p.x + v.dx; }); void s; } };
  }, N, iter));

  results.push(bench("real: batch(Pos,Vel)", () => {
    const w = new World(); spawn_realistic(w);
    return { run() { let s = 0; w.query(Pos, Vel).batch((p: any, v: any, _e: any, c: number) => { for (let i = 0; i < c; i++) s += p[i].x + v[i].dx; }); void s; } };
  }, N, iter));

  results.push(bench("real: forEach(Pos,Size,Color)", () => {
    const w = new World(); spawn_realistic(w);
    return { run() { let s = 0; w.query(Pos, Size, Color).forEach((p: any, sz: any, c: any) => { s += p.x + sz.w + c.r; }); void s; } };
  }, N, iter));

  results.push(bench("real: batch(Pos,Size,Color)", () => {
    const w = new World(); spawn_realistic(w);
    return { run() { let s = 0; w.query(Pos, Size, Color).batch((p: any, sz: any, c: any, _e: any, n: number) => { for (let i = 0; i < n; i++) s += p[i].x + sz[i].w + c[i].r; }); void s; } };
  }, N, iter));

  // ── Filter query ──
  console.log(`\n── 3. Filter performance ──`);

  // ── Spawn throughput (measures _grow() cost) ──
  console.log(`\n── 3. Spawn throughput (100k entities, 10 rounds) ──`);
  const spawn_iter = 10;

  results.push(bench("spawn: ObjectColumn(Pos+Vel)", () => {
    return { run() { const w = new World(); for (let i = 0; i < N; i++) w.spawn([Pos.create({ x: i }), Vel.create({ dx: 1 })]); } };
  }, N, spawn_iter));

  results.push(bench("spawn: Float64Column(pos_f64+vel_f64)", () => {
    return { run() { const w = new World(); for (let i = 0; i < N; i++) w.spawn([pos_f64.create({ x: i }), vel_f64.create({ dx: 1 })]); } };
  }, N, spawn_iter));

  // ── Destroy / remove throughput ──
  console.log(`\n── 4. Destroy & remove (10k entities, 50 rounds) ──`);
  const destroy_n = 10000, destroyIter = 50;

  results.push(bench("destroy: table only (1c, Pos)", () => {
    const entities: Entity[] = [];
    const w = new World();
    for (let i = 0; i < destroy_n; i++) entities.push(w.spawn([Pos.create({ x: i })]));
    return { run() { for (let i = 0; i < destroy_n; i++) w.destroy(entities[i]); w.flushDestroyed(); } };
  }, destroy_n, destroyIter));

  results.push(bench("destroy: table (10c, rich entity)", () => {
    const entities: Entity[] = [];
    const w = new World();
    for (let i = 0; i < destroy_n; i++) entities.push(w.spawn([
      Pos.create({ x: i }), Vel.create({ dx: 1 }), Size.create({ w: 1, h: 1 }),
      Color.create({ r: 255, g: 0, b: 0 }), Alpha.create({ value: 1 }),
      Speed.create({ value: 1 }), Rot.create({ angle: 0 }), Scale.create({ x: 1, y: 1 }),
      Hp.create({ current: 100, max: 100 }), Team.create({ id: 0 }),
    ]));
    return { run() { for (let i = 0; i < destroy_n; i++) w.destroy(entities[i]); w.flushDestroyed(); } };
  }, destroy_n, destroyIter));

  results.push(bench("destroy: sparse only (sparse_tag)", () => {
    const entities: Entity[] = [];
    const w = new World();
    for (let i = 0; i < destroy_n; i++) entities.push(w.spawn([sparse_tag.create({ v: 1 })]));
    return { run() { for (let i = 0; i < destroy_n; i++) w.destroy(entities[i]); w.flushDestroyed(); } };
  }, destroy_n, destroyIter));

  // removeComponent consumes component data, so each run must recreate entities.
  // Spawn-only baselines let us subtract: removeCost = total - spawn
  results.push(bench("spawn: Pos+Vel (remove baseline)", () => {
    return { run() {
      const w = new World();
      for (let i = 0; i < destroy_n; i++) w.spawn([Pos.create({ x: i }), Vel.create({ dx: 1 })]);
    } };
  }, destroy_n, destroyIter));

  results.push(bench("spawn: Pos+sparse_tag (remove baseline)", () => {
    return { run() {
      const w = new World();
      for (let i = 0; i < destroy_n; i++) w.spawn([Pos.create({ x: i }), sparse_tag.create({ v: 1 })]);
    } };
  }, destroy_n, destroyIter));

  results.push(bench("removeComponent: table (remove Pos from Pos+Vel)", () => {
    return { run() {
      const w = new World(); const e: Entity[] = [];
      for (let i = 0; i < destroy_n; i++) e.push(w.spawn([Pos.create({ x: i }), Vel.create({ dx: 1 })]));
      for (let i = 0; i < destroy_n; i++) w.removeComponent(e[i], Pos);
    } };
  }, destroy_n, destroyIter));

  results.push(bench("removeComponent: sparse (remove sparse_tag from Pos+Tag)", () => {
    return { run() {
      const w = new World(); const e: Entity[] = [];
      for (let i = 0; i < destroy_n; i++) e.push(w.spawn([Pos.create({ x: i }), sparse_tag.create({ v: 1 })]));
      for (let i = 0; i < destroy_n; i++) w.removeComponent(e[i], sparse_tag);
    } };
  }, destroy_n, destroyIter));

  const { Changed } = require("../src/index.js");
  results.push(bench("filter: Changed(Pos).forEach", () => {
    const w = new World();
    for (let i = 0; i < N; i++) w.spawn([Pos.create({ x: i }), Vel.create({ dx: 1 })]);
    w.setCurrentObserver("bench");
    return { run() { let s = 0; w.query(Pos, Vel).filter(Changed(Pos)).forEach((p: any, v: any) => { s += p.x + v.dx; }); void s; } };
  }, N, iter));

  return results;
}

// ── Snapshot management ──
const __dirname = path.dirname(new URL(import.meta.url).pathname);
const SNAPSHOT_FILE = path.join(__dirname, "ecs.bench-snapshot.json");

function save_snapshot(results: BenchResult[]) {
  const data = {
    timestamp: new Date().toISOString(),
    runtime,
    results: results.map(r => ({ name: r.name, throughput: r.throughput, usPerIter: r.usPerIter })),
  };
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(data, null, 2));
  console.log(`\nSnapshot saved -> ecd.bench-snapshot.json`);
}

function compare_with_snapshot(results: BenchResult[]) {
  if (!fs.existsSync(SNAPSHOT_FILE)) {
    console.log(`\nNo baseline snapshot found. Run with --save to create one.`);
    return;
  }
  const baseline = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf-8"));
  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  vs baseline: ${baseline.timestamp.split("T")[0]} (${baseline.runtime})`.padEnd(65) + `║`);
  console.log(`╠══════════════════════════════════════════════════════════════╣`);

  const baseline_map = new Map(baseline.results.map((r: any) => [r.name, r.throughput]));
  let total_delta = 0, count = 0;

  for (const r of results) {
    const base = baseline_map.get(r.name);
    if (base !== undefined) {
      const delta = ((r.throughput - base) / base * 100);
      const arrow = delta > 0.5 ? "▲" : delta < -0.5 ? "▼" : " ";
      const prefix = delta > 0.5 ? "+" : "";
      console.log(`  ${r.name.padEnd(48)} ${base.toFixed(0).padStart(6)} → ${r.throughput.toFixed(0).padStart(6)} M/s  ${arrow}${prefix}${delta.toFixed(1)}%`);
      total_delta += delta;
      count++;
    } else {
      console.log(`  ${r.name.padEnd(48)}     NEW → ${r.throughput.toFixed(0).padStart(6)} M/s`);
    }
  }
  if (count > 0) {
    const avg = total_delta / count;
    const arrow = avg > 0.5 ? "▲" : avg < -0.5 ? "▼" : " ";
    console.log(`  ${"─".repeat(60)}`);
    console.log(`  AVERAGE${"".padEnd(41)} ${arrow}${avg > 0 ? "+" : ""}${avg.toFixed(1)}%`);
  }
  console.log(`╚══════════════════════════════════════════════════════════════╝`);
}

// ── Main ──
const results = runAll();

if (process.argv.includes("--save")) {
  save_snapshot(results);
} else {
  compare_with_snapshot(results);
}
