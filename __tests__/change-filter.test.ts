// packages/ecs/__tests__/change-filter.test.ts
// Changed/Added 过滤契约（Gherkin 验收——P2-03：masterChanged 快路径移除后按 kind 精确判断）

import { describe, it, expect } from "vitest";
import { World, defineComponent, Changed, Added } from "zero-ecs";

const A = defineComponent("a", { v: 0 });
const B = defineComponent("b", { v: 0 });

describe("Feature: Changed/Added 过滤器（按 kind 精确判断，同 observer 多查询无干扰）", () => {
  it("Scenario: Given 实体同时含 A、B（同 tick 生成）——When 同 observer 先查 Changed(A) 再查 Changed(B)——Then 两者都命中（master 标量不再误跳过）", () => {
    const world = new World();
    const e = world.spawn([A.create({ v: 1 }), B.create({ v: 1 })]);
    world.setCurrentObserver("sys");

    const seenA: number[] = [];
    world.query(A).filter(Changed(A)).forEach((_a, ent) => seenA.push(ent));
    const seenB: number[] = [];
    world.query(B).filter(Changed(B)).forEach((_b, ent) => seenB.push(ent));

    expect(seenA).toEqual([e]);
    expect(seenB).toEqual([e]);
  });

  it("Scenario: Given Changed(A) 已消费——When B 再变更——Then Changed(B) 仍命中（独立 kind 通道）", () => {
    const world = new World();
    const e = world.spawn([A.create({ v: 1 }), B.create({ v: 1 })]);
    world.setCurrentObserver("sys");

    world.query(A).filter(Changed(A)).forEach(() => {});
    world.setComponent(e, B.create({ v: 2 }));
    const seenB: number[] = [];
    world.query(B).filter(Changed(B)).forEach((_b, ent) => seenB.push(ent));
    expect(seenB).toEqual([e]);
  });

  it("Scenario: Given 同 observer 双 Changed 查询 forEach 与 entities 结果一致——Then 无跨路径分歧", () => {
    const world = new World();
    const e = world.spawn([A.create({ v: 1 }), B.create({ v: 1 })]);
    world.setCurrentObserver("sys");

    const fe: number[] = [];
    world.query(A).filter(Changed(A)).forEach((_a, ent) => fe.push(ent));
    const en = world.query(B).filter(Changed(B)).entities();
    expect(fe).toEqual([e]);
    expect(en).toEqual([e]);
  });

  it("Scenario: Given first() 带 Changed 过滤——When 查询——Then 只返回真正变更的实体（行级过滤器生效）", () => {
    const world = new World();
    world.spawn([A.create({ v: 1 }), B.create({ v: 1 })]);
    const e2 = world.spawn([A.create({ v: 2 }), B.create({ v: 2 })]);
    world.setCurrentObserver("sys");

    // 消费 A、B（两实体都清掉）
    world.query(A).filter(Changed(A)).forEach(() => {});
    world.query(B).filter(Changed(B)).forEach(() => {});
    // 只改 e2 的 B——A 未变
    world.setComponent(e2, B.create({ v: 3 }));
    const firstA = world.query(A).filter(Changed(A)).first();
    expect(firstA).toBeUndefined();

    // 但 Changed(B) 能命中 e2
    const firstB = world.query(B).filter(Changed(B)).first();
    expect(firstB).toBe(e2);
  });

  it("Scenario: Given 单查询带两个 Changed filter——When A 已消费 B 未消费——Then 实体命中（各 filter 独立 lastSeen）", () => {
    const world = new World();
    const e = world.spawn([A.create({ v: 1 }), B.create({ v: 1 })]);
    world.setCurrentObserver("sys");

    // 只消费 A——B 保持未消费
    world.query(A).filter(Changed(A)).forEach(() => {});

    // 同查询两个 Changed filter：B 未消费 → 必须命中（不能串用 A 的 lastSeen）
    const hit: number[] = [];
    world.query(A, B).filter(Changed(A), Changed(B)).forEach((_a, _b, ent) => hit.push(ent));
    expect(hit).toEqual([e]);
  });

  it("Scenario: Given Added 过滤器——When 查询已消费后新加组件——Then Added 命中（独立通道）", () => {
    const world = new World();
    const e = world.spawn([A.create({ v: 1 })]);
    world.setCurrentObserver("sys");

    const r1 = world.query(A).filter(Changed(A)).entities();
    expect(r1).toEqual([e]);

    world.setComponent(e, B.create({ v: 1 }));
    const r2 = world.query(B).filter(Added(B)).entities();
    expect(r2).toEqual([e]);
  });
});
