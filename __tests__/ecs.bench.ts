// packages/ecs/__tests__/ecs.bench.ts — ECS benchmark suite with snapshot comparison
// @ts-nocheck
// 默认（10K 规模，日常回归）: bun run packages/ecs/__tests__/ecs.bench.ts [--save]
// 完整（100K 规模，发布前）:  bun run packages/ecs/__tests__/ecs.bench.ts --full [--save]
// --save: 保存当前模式的结果作为基线快照
// --check: 平均吞吐相对基线回退 >15% 时 exit 1（性能门禁）

import { World, defineComponent, Changed } from "../src/index.js";
import * as fs from "node:fs";
import * as path from "node:path";

const is_bun = typeof (globalThis as any).Bun !== "undefined";
const runtime = is_bun ? `Bun ${(globalThis as any).Bun.version}` : `Node ${process.version}`;
const now: () => number = is_bun ? (globalThis as any).Bun.nanoseconds : () => performance.now() * 1e6;
const NS_TO_MS = 1e6;

// 默认 10K：日常回归足够快；--full 恢复 100K 发布前基准。
const FULL = process.argv.includes("--full") || process.argv.includes("--heavy");
const BENCH_N = FULL ? 100_000 : 10_000;
const BENCH_ITER = FULL ? 100 : 20;
const SAMPLES = FULL ? 5 : 3;
const CHECK = process.argv.includes("--check");
const THRESHOLD_PCT = 15;
const PER_CASE_THRESHOLD_PCT = 25;
const PER_CASE_MIN_US = 20;

// ── Components ──
const Pos   = defineComponent("bnPos",   { x: 0, y: 0, z: 0 });
const Vel   = defineComponent("bnVel",   { dx: 0, dy: 0, dz: 0 });
// Float64Column variants (interleaved SoA)
const pos_f64 = defineComponent("bnPosF64", { x: 0, y: 0, z: 0 }, { schema: { x: "float64", y: "float64", z: "float64" } });
const vel_f64 = defineComponent("bnVelF64", { dx: 0, dy: 0, dz: 0 }, { schema: { dx: "float64", dy: "float64", dz: "float64" } });
// Tag component：archetype ObjectColumn
const tag = defineComponent("bnTag", { v: 0 });
// Tag component：archetype Float64Column
const tag_f64 = defineComponent("bnTagF64", { a: 0, b: 0, c: 0 }, { schema: { a: "float64", b: "float64", c: "float64" } });
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
// Query cache 专项：60 个变体组件 → 60 archetype（Pos+Vel+variant）
const varComps: any[] = [];
for (let i = 0; i < 60; i++) varComps.push(defineComponent(`bnVar${i}`, { v: 0 }));

// ── Benchmark harness ──
interface BenchResult {
  name: string;
  throughput: number;  // M entities/s
  usPerIter: number;
}

// min-of-samples: single-sample measurements are dominated by JIT warmup noise
// (measured 3x variance on identical code). Sample repeatedly, report the min.
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
  const N = BENCH_N, iter = BENCH_ITER;
  const mode = FULL ? "FULL" : "DEFAULT-10K";

  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  learnvis ECS Benchmark — ${runtime.padEnd(35)}║`);
  console.log(`║  mode=${mode.padEnd(10)} N=${String(N).padEnd(7)} iter=${String(iter).padEnd(4)} samples=${SAMPLES}`.padEnd(65) + `║`);
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

  // ── Tag mixed: archetype column + tag in same query ──
  console.log(`\n── 1c. Tag mixed: ObjectColumn + tag in same query ──`);

  results.push(bench("tag: forEach(Pos,tag)", () => {
    const w = new World();
    for (let i = 0; i < N; i++) w.spawn([Pos.create({ x: i }), tag.create({ v: 1 })]);
    return { run() { let s = 0; w.query(Pos, tag).forEach((p: any, t: any) => { s += p.x + t.v; }); void s; } };
  }, N, iter));

  results.push(bench("tag: batch(Pos,tag)", () => {
    const w = new World();
    for (let i = 0; i < N; i++) w.spawn([Pos.create({ x: i }), tag.create({ v: 1 })]);
    return { run() { let s = 0; w.query(Pos, tag).batch((p: any, t: any, _e: any, c: number) => { for (let i = 0; i < c; i++) s += p[i].x + t[i].v; }); void s; } };
  }, N, iter));

  // ── Tag Float64: archetype Float64Column ──
  console.log(`\n── 1d. Tag Float64: archetype Float64Column ──`);

  results.push(bench("tagF64: forEach(Pos,tag_f64)", () => {
    const w = new World();
    for (let i = 0; i < N; i++) w.spawn([Pos.create({ x: i }), tag_f64.create({ a: i, b: 0, c: 0 })]);
    return { run() { let s = 0; w.query(Pos, tag_f64).forEach((p: any, s64: any) => { s += p.x + s64.a; }); void s; } };
  }, N, iter));

  results.push(bench("tagF64: batch(Pos,tag_f64)", () => {
    const w = new World();
    for (let i = 0; i < N; i++) w.spawn([Pos.create({ x: i }), tag_f64.create({ a: i, b: 0, c: 0 })]);
    // batch receives Record[] per entity（tag 列也走对象快照，非 typed view）
    return { run() { let s = 0; w.query(Pos, tag_f64).batch((p: any, s64: any, _e: any, c: number) => { for (let i = 0; i < c; i++) s += p[i].x + s64[i].a; }); void s; } };
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
  console.log(`\n── 3. Spawn throughput (${N} entities, ${FULL ? 10 : 5} rounds) ──`);
  const spawn_iter = FULL ? 10 : 5;

  results.push(bench("spawn: ObjectColumn(Pos+Vel)", () => {
    return { run() { const w = new World(); for (let i = 0; i < N; i++) w.spawn([Pos.create({ x: i }), Vel.create({ dx: 1 })]); } };
  }, N, spawn_iter));

  results.push(bench("spawn: Float64Column(pos_f64+vel_f64)", () => {
    return { run() { const w = new World(); for (let i = 0; i < N; i++) w.spawn([pos_f64.create({ x: i }), vel_f64.create({ dx: 1 })]); } };
  }, N, spawn_iter));

  // ── Destroy / remove throughput ──
  const destroy_n = FULL ? 10000 : 2000;
  const destroyIter = FULL ? 50 : 20;
  console.log(`\n── 4. Destroy & remove (${destroy_n} entities, ${destroyIter} rounds) ──`);

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

  results.push(bench("destroy: tag only (tag)", () => {
    const entities: Entity[] = [];
    const w = new World();
    for (let i = 0; i < destroy_n; i++) entities.push(w.spawn([tag.create({ v: 1 })]));
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

  results.push(bench("spawn: Pos+tag (remove baseline)", () => {
    return { run() {
      const w = new World();
      for (let i = 0; i < destroy_n; i++) w.spawn([Pos.create({ x: i }), tag.create({ v: 1 })]);
    } };
  }, destroy_n, destroyIter));

  results.push(bench("removeComponent: table (remove Pos from Pos+Vel)", () => {
    return { run() {
      const w = new World(); const e: Entity[] = [];
      for (let i = 0; i < destroy_n; i++) e.push(w.spawn([Pos.create({ x: i }), Vel.create({ dx: 1 })]));
      for (let i = 0; i < destroy_n; i++) w.removeComponent(e[i], Pos);
    } };
  }, destroy_n, destroyIter));

  results.push(bench("removeComponent: tag (remove tag from Pos+Tag)", () => {
    return { run() {
      const w = new World(); const e: Entity[] = [];
      for (let i = 0; i < destroy_n; i++) e.push(w.spawn([Pos.create({ x: i }), tag.create({ v: 1 })]));
      for (let i = 0; i < destroy_n; i++) w.removeComponent(e[i], tag);
    } };
  }, destroy_n, destroyIter));

  const { Changed } = require("../src/index.js");
  results.push(bench("filter: Changed(Pos).forEach", () => {
    const w = new World();
    for (let i = 0; i < N; i++) w.spawn([Pos.create({ x: i }), Vel.create({ dx: 1 })]);
    w.setCurrentObserver("bench");
    return { run() { let s = 0; w.query(Pos, Vel).filter(Changed(Pos)).forEach((p: any, v: any) => { s += p.x + v.dx; }); void s; } };
  }, N, iter));

  // ── Story P0-04: 批量写 vs 逐实体（Float64 列级直写）──
  console.log(`\n── 6. Batch write (Story P0-04): setComponents vs setComponent loop ──`);
  const bwN = 10000, bwIter = 100;

  results.push(bench("batch-write: setComponents(Float64) 10K", () => {
    const w = new World();
    const es: Entity[] = [];
    for (let i = 0; i < bwN; i++) es.push(w.spawn([pos_f64.create({ x: i, y: 0, z: 0 })]));
    return { run() { w.setComponents(pos_f64, es, { x: 1.5, y: 2.5, z: 3.5 }); } };
  }, bwN, bwIter));

  results.push(bench("batch-write: setComponent loop(Float64) 10K", () => {
    const w = new World();
    const es: Entity[] = [];
    for (let i = 0; i < bwN; i++) es.push(w.spawn([pos_f64.create({ x: i, y: 0, z: 0 })]));
    return { run() { for (const e of es) w.setComponent(e, pos_f64.create({ x: 1.5, y: 2.5, z: 3.5 })); } };
  }, bwN, bwIter));

  // ── Query archetype cache: 多 archetype 稳态交集（computeCandidates 开销）──
  console.log(`\n── 5. Query cache: 多 archetype 稳态交集 ──`);

  results.push(bench("query-cache: 40 arch × 25 ent (Pos,Vel) forEach", () => {
    const w = new World();
    for (let vi = 0; vi < 40; vi++) {
      for (let i = 0; i < 25; i++) w.spawn([Pos.create({ x: i }), Vel.create({ dx: 1 }), varComps[vi].create({ v: 1 })]);
    }
    return { run() { let s = 0; w.query(Pos, Vel).forEach((p: any, v: any) => { s += p.x + v.dx; }); void s; } };
  }, 1000, 100));

  // 纯交集开销：60 archetype 各 1 实体（遍历极小，交集计算是主开销），高迭代放大
  results.push(bench("query-cache-empty: 60 arch (Pos,Vel) 交集开销", () => {
    const w = new World();
    for (let vi = 0; vi < 60; vi++) w.spawn([Pos.create({ x: 1 }), Vel.create({ dx: 1 }), varComps[vi].create({ v: 1 })]);
    return { run() { let s = 0; w.query(Pos, Vel).forEach((p: any, v: any) => { s += p.x + v.dx; }); void s; } };
  }, 60, 500));

  // 有 Without 过滤的稳态交集（含 archetype 级过滤）
  results.push(bench("query-cache-without: 60 arch (Pos,Vel,Without variant0)", () => {
    const w = new World();
    for (let vi = 0; vi < 60; vi++) w.spawn([Pos.create({ x: 1 }), Vel.create({ dx: 1 }), varComps[vi].create({ v: 1 })]);
    const { Without } = require("../src/index.js");
    return { run() { let s = 0; w.query(Pos, Vel).filter(Without(varComps[0])).forEach((p: any, v: any) => { s += p.x + v.dx; }); void s; } };
  }, 60, 500));

  return results;
}

// ── Snapshot management ──
const __dirname = path.dirname(new URL(import.meta.url).pathname);
const SNAPSHOT_FILE = path.join(
  __dirname,
  FULL ? "ecs.bench-snapshot.json" : "ecs.bench-snapshot-10k.json",
);

function save_snapshot(results: BenchResult[]) {
  const data = {
    timestamp: new Date().toISOString(),
    runtime,
    mode: FULL ? "full" : "10k",
    N: BENCH_N,
    iter: BENCH_ITER,
    samples: SAMPLES,
    results: results.map(r => ({ name: r.name, throughput: r.throughput, usPerIter: r.usPerIter })),
  };
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(data, null, 2));
  console.log(`\nSnapshot saved -> ${path.basename(SNAPSHOT_FILE)}`);
}

function compare_with_snapshot(results: BenchResult[]): { avg: number | undefined; matched: number; worst: number } {
  if (!fs.existsSync(SNAPSHOT_FILE)) {
    console.log(`\nNo baseline snapshot found. Run with --save to create one.`);
    if (CHECK) process.exit(1);
    return { avg: undefined, matched: 0, worst: 0 };
  }
  const baseline = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf-8"));
  const mode = FULL ? "full" : "10k";
  const metadataMismatch =
    baseline.mode !== mode ||
    baseline.N !== BENCH_N ||
    baseline.iter !== BENCH_ITER ||
    baseline.samples !== SAMPLES;
  if (metadataMismatch) {
    console.log(`\nBaseline metadata mismatch (${JSON.stringify({ mode: baseline.mode, N: baseline.N, iter: baseline.iter, samples: baseline.samples })} != ${JSON.stringify({ mode, N: BENCH_N, iter: BENCH_ITER, samples: SAMPLES })}); skipped.`);
    if (CHECK) process.exit(1);
    return { avg: undefined, matched: 0, worst: 0 };
  }
  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  vs baseline: ${baseline.timestamp.split("T")[0]} (${baseline.runtime})`.padEnd(65) + `║`);
  console.log(`╠══════════════════════════════════════════════════════════════╣`);

  const baseline_map = new Map(baseline.results.map((r: any) => [r.name, r]));
  let total_delta = 0, count = 0, worst = 0;

  for (const r of results) {
    const baseRow = baseline_map.get(r.name);
    if (baseRow !== undefined) {
      const base = baseRow.throughput;
      const delta = ((r.throughput - base) / base * 100);
      const arrow = delta > 0.5 ? "▲" : delta < -0.5 ? "▼" : " ";
      const prefix = delta > 0.5 ? "+" : "";
      console.log(`  ${r.name.padEnd(48)} ${base.toFixed(0).padStart(6)} → ${r.throughput.toFixed(0).padStart(6)} M/s  ${arrow}${prefix}${delta.toFixed(1)}%`);
      total_delta += delta;
      count++;
      if ((baseRow.usPerIter ?? 0) >= PER_CASE_MIN_US) worst = Math.min(worst, delta);
    } else {
      console.log(`  ${r.name.padEnd(48)}     NEW → ${r.throughput.toFixed(0).padStart(6)} M/s`);
    }
  }
  let avg: number | undefined;
  if (count > 0) {
    avg = total_delta / count;
    const arrow = avg > 0.5 ? "▲" : avg < -0.5 ? "▼" : " ";
    console.log(`  ${"─".repeat(60)}`);
    console.log(`  AVERAGE${"".padEnd(41)} ${arrow}${avg > 0 ? "+" : ""}${avg.toFixed(1)}%`);
    console.log(`  WORST (>=${PER_CASE_MIN_US}µs cases)${"".padEnd(24)} ${worst > 0 ? "+" : ""}${worst.toFixed(1)}%`);
  } else if (CHECK) {
    console.log(`\nNo matching benchmark keys; gate fails.`);
    process.exit(1);
  }
  console.log(`╚══════════════════════════════════════════════════════════════╝`);
  return { avg, matched: count, worst };
}

// ── Main ──
const results = runAll();

if (process.argv.includes("--save")) {
  save_snapshot(results);
} else {
  const { avg, matched, worst } = compare_with_snapshot(results);
  if (CHECK) {
    if (avg === undefined || matched === 0) process.exit(1);
    if (avg < -THRESHOLD_PCT) {
      console.error(`\nPerf gate failed: average throughput ${avg.toFixed(1)}% (threshold -${THRESHOLD_PCT}%).`);
      process.exit(1);
    }
    if (worst < -PER_CASE_THRESHOLD_PCT) {
      console.error(`\nPerf gate failed: worst stable case ${worst.toFixed(1)}% (threshold -${PER_CASE_THRESHOLD_PCT}%).`);
      process.exit(1);
    }
  }
}
