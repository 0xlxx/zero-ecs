// Story P0-04：World.setComponents 批量写 API（列级批量 + Float64 快路径）

import { describe, it, expect } from "vitest";
import { World, defineComponent, Changed } from "../src/index.js";
import type { Entity } from "../src/index.js";

const Pos = defineComponent("bwPos", { x: 0, y: 0, z: 0 });
const Vel = defineComponent("bwVel", { dx: 0, dy: 0 });
const Hp = defineComponent("bwHp", { value: 100 });
// Float64 SoA 组件
const PosF64 = defineComponent(
  "bwPosF64",
  { x: 0, y: 0, z: 0 },
  { schema: { x: "float64", y: "float64", z: "float64" } },
);

function spawnMany(w: World, n: number): Entity[] {
  const out: Entity[] = [];
  for (let i = 0; i < n; i++) out.push(w.spawn([Pos.create({ x: i, y: 0, z: 0 })]));
  return out;
}

describe("World.setComponents", () => {
  it("同 patch 应用到多实体（统一值）", () => {
    const w = new World();
    const es = spawnMany(w, 5);
    const written = w.setComponents(Pos, es, { x: 9, y: 1 });
    expect(written).toBe(5);
    for (const e of es) {
      const p = w.getComponent(e, Pos)!;
      expect(p.x).toBe(9);
      expect(p.y).toBe(1);
      expect(p.z).toBe(0); // 未 patch 字段保留
    }
  });

  it("per-entity patch 数组（每实体不同值）", () => {
    const w = new World();
    const es = spawnMany(w, 3);
    w.setComponents(Pos, es, [{ x: 10 }, { x: 20 }, { x: 30 }]);
    expect(w.getComponent(es[0], Pos)!.x).toBe(10);
    expect(w.getComponent(es[1], Pos)!.x).toBe(20);
    expect(w.getComponent(es[2], Pos)!.x).toBe(30);
  });

  it("Float64 快路径：数值字段直写（零装箱语义一致）", () => {
    const w = new World();
    const es: Entity[] = [];
    for (let i = 0; i < 4; i++) es.push(w.spawn([PosF64.create({ x: i, y: 0, z: 0 })]));
    w.setComponents(PosF64, es, [{ x: 1.5 }, { x: 2.5 }, { x: 3.5 }, { x: 4.5 }]);
    for (let i = 0; i < 4; i++) {
      const p = w.getComponent(es[i], PosF64)!;
      expect(p.x).toBe(i + 1.5);
    }
  });

  it("混合 archetype（不同组件组合的实体批量写）", () => {
    const w = new World();
    const a = w.spawn([Pos.create(), Hp.create({ value: 10 })]);
    const b = w.spawn([Pos.create(), Vel.create({ dx: 1 })]);
    const c = w.spawn([Pos.create()]);
    w.setComponents(Pos, [a, b, c], { y: 7 });
    expect(w.getComponent(a, Pos)!.y).toBe(7);
    expect(w.getComponent(b, Pos)!.y).toBe(7);
    expect(w.getComponent(c, Pos)!.y).toBe(7);
  });

  it("跳过无此组件/已销毁实体，返回实际写入数", () => {
    const w = new World();
    const ok = w.spawn([Pos.create()]);
    const noPos = w.spawn([Hp.create({ value: 1 })]);
    const dead = w.spawn([Pos.create()]);
    w.destroy(dead);
    w.flushDestroyed();
    const written = w.setComponents(Pos, [ok, noPos, dead], { x: 5 });
    expect(written).toBe(1);
    expect(w.getComponent(ok, Pos)!.x).toBe(5);
    expect(w.getComponent(noPos, Pos)).toBeUndefined();
  });

  it("批量写触发 Changed 过滤（先 seen 基线再批量写——增量）", () => {
    const w = new World();
    const es = spawnMany(w, 3);
    w.setCurrentObserver("test");
    w.query(Pos).filter(Changed(Pos)).entities(); // seen 基线（吸收 spawn tick）
    w.setComponents(Pos, es, { x: 1 });
    const changed = w.query(Pos).filter(Changed(Pos)).entities();
    expect(changed).toHaveLength(3);
    // 再查（已 seen）→ 空
    expect(w.query(Pos).filter(Changed(Pos)).entities()).toHaveLength(0);
  });

  it("与逐实体 setComponent 结果一致（语义等价）", () => {
    const w1 = new World();
    const es1 = spawnMany(w1, 3);
    for (const e of es1) {
      const p = w1.getComponent(e, Pos)!;
      w1.setComponent(e, Pos.create({ ...p, x: 42, y: 3 }));
    }
    const w2 = new World();
    const es2 = spawnMany(w2, 3);
    w2.setComponents(Pos, es2, { x: 42, y: 3 });
    for (let i = 0; i < 3; i++) {
      const a = w1.getComponent(es1[i], Pos)!;
      const b = w2.getComponent(es2[i], Pos)!;
      expect(b).toEqual(a);
    }
  });

  it("空实体列表返回 0", () => {
    const w = new World();
    expect(w.setComponents(Pos, [], { x: 1 })).toBe(0);
  });
});
