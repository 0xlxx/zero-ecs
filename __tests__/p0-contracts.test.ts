// P0 ECS contracts: defaults ownership, lifecycle hooks, query state,
// removed-component readers, and mutation-safe forEach iteration.

import { describe, expect, it, vi } from "vitest";
import {
  Added,
  Changed,
  Commands,
  defineComponent,
  f,
  World,
} from "../src/index.js";
import { parseFields } from "../src/field.js";

describe("Feature: P0 component default ownership", () => {
  const DefaultsProbe = defineComponent("p0DefaultsProbe", {
    list: f.array(f.num()).default([1]),
    map: f.map(f.num()).default({ a: 1 }),
    obj: f.obj({ x: f.num() }).default({ x: 1 }),
    tuple: f.tuple(f.num(), f.num()).default([1, 2]),
  });

  it("Scenario: Given mutable defaults——When two instances are created——Then nested values never alias", () => {
    const a = DefaultsProbe({});
    const b = DefaultsProbe({});

    expect(a.list).not.toBe(b.list);
    expect(a.map).not.toBe(b.map);
    expect(a.obj).not.toBe(b.obj);
    expect(a.tuple).not.toBe(b.tuple);

    a.list.push(2);
    a.map.a = 2;
    a.obj.x = 2;
    a.tuple[0] = 2;

    expect(b.list).toEqual([1]);
    expect(b.map).toEqual({ a: 1 });
    expect(b.obj).toEqual({ x: 1 });
    expect(b.tuple).toEqual([1, 2]);
  });

  it("Scenario: Given parseFields default values——When parsed twice——Then each result owns its nested value", () => {
    const fields = {
      list: f.array(f.num()).default([1]),
      map: f.map(f.num()).default({ a: 1 }),
    };
    const first = parseFields(fields, {});
    const second = parseFields(fields, {});

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const firstValue = first.value as { list: number[]; map: Record<string, number> };
    const secondValue = second.value as { list: number[]; map: Record<string, number> };
    expect(firstValue.list).not.toBe(secondValue.list);
    expect(firstValue.map).not.toBe(secondValue.map);
    firstValue.list.push(2);
    firstValue.map.a = 2;
    expect(secondValue.list).toEqual([1]);
    expect(secondValue.map).toEqual({ a: 1 });
  });
});

describe("Feature: P0 component lifecycle hooks", () => {
  const LifecycleProbe = defineComponent("p0LifecycleProbe", {
    value: f.num().default(0),
  });
  const MissingProbe = defineComponent("p0MissingRemoveProbe", {
    value: f.num().default(0),
  });

  it("Scenario: Given an empty reserved entity——When a component is inserted——Then onAdd and onChanged fire exactly once", () => {
    const world = new World();
    let added = 0;
    let changed = 0;
    let setAlias = 0;
    world.onAdd(LifecycleProbe, () => added++);
    world.onChanged(LifecycleProbe, () => changed++);
    world.onSet(LifecycleProbe, () => setAlias++);

    const commands = new Commands(world);
    commands.spawn().insert(LifecycleProbe({ value: 1 }));
    world.applyCommands();

    expect(added).toBe(1);
    expect(changed).toBe(1);
    expect(setAlias).toBe(1);
  });

  it("Scenario: Given existing component——When set again——Then onChanged fires and onAdd does not", () => {
    const world = new World();
    let added = 0;
    let changed = 0;
    world.onAdd(LifecycleProbe, () => added++);
    world.onChanged(LifecycleProbe, () => changed++);
    const entity = world.spawn([LifecycleProbe({ value: 1 })]);

    world.setComponent(entity, LifecycleProbe({ value: 2 }));

    expect(added).toBe(1);
    expect(changed).toBe(2);
  });

  it("Scenario: Given missing component——When removed——Then onRemove does not fire", () => {
    const world = new World();
    const entity = world.spawn([MissingProbe({ value: 1 })]);
    let removed = 0;
    world.onRemove(LifecycleProbe, () => removed++);

    world.removeComponent(entity, LifecycleProbe);

    expect(removed).toBe(0);
  });

  it("Scenario: Given existing component——When removed or destroyed——Then onRemove fires once per actual removal", () => {
    const world = new World();
    const removedValues: number[] = [];
    const entity = world.spawn([LifecycleProbe({ value: 1 })]);
    world.onRemove(LifecycleProbe, (_entity, data) => removedValues.push(data?.value as number));

    world.removeComponent(entity, LifecycleProbe);
    world.removeComponent(entity, LifecycleProbe);
    expect(removedValues).toEqual([1]);

    const destroyed = world.spawn([LifecycleProbe({ value: 2 })]);
    world.destroy(destroyed);
    world.flushDestroyed();
    expect(removedValues).toEqual([1, 2]);
  });

  it("Scenario: Given a throwing hook——When a component changes——Then mutation completes and later hooks still run", () => {
    const world = new World();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let laterHook = 0;
    const entity = world.spawn([LifecycleProbe({ value: 1 })]);
    world.onChanged(LifecycleProbe, () => {
      throw new Error("hook failure");
    });
    world.onChanged(LifecycleProbe, () => laterHook++);

    expect(() => world.setComponent(entity, LifecycleProbe({ value: 2 }))).not.toThrow();
    expect(world.getComponent(entity, LifecycleProbe)?.value).toBe(2);
    expect(laterHook).toBe(1);
    errorSpy.mockRestore();
  });

  it("Scenario: Given add, change, and remove observers——When a component moves through its lifecycle——Then hooks run in contract order", () => {
    const world = new World();
    const events: string[] = [];
    world.onAdd(LifecycleProbe, (entity) => {
      events.push(`add:${world.getComponent(entity, LifecycleProbe)?.value}`);
    });
    world.onChanged(LifecycleProbe, (_entity, data) => {
      events.push(`changed:${data?.value}`);
    });
    world.onRemove(LifecycleProbe, (entity, data) => {
      events.push(`remove:${data?.value}:${world.getComponent(entity, LifecycleProbe)?.value}`);
    });

    const entity = world.spawn([LifecycleProbe({ value: 1 })]);
    world.setComponent(entity, LifecycleProbe({ value: 2 }));
    world.removeComponent(entity, LifecycleProbe);

    expect(events).toEqual(["add:1", "changed:1", "changed:2", "remove:2:2"]);
  });

  it("Scenario: Given throwing add and remove hooks——When the mutation runs——Then the mutation completes and later hooks still run", () => {
    const world = new World();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let laterAdd = 0;
    let laterRemove = 0;
    world.onAdd(LifecycleProbe, () => {
      throw new Error("add failure");
    });
    world.onAdd(LifecycleProbe, () => laterAdd++);
    world.onRemove(LifecycleProbe, () => {
      throw new Error("remove failure");
    });
    world.onRemove(LifecycleProbe, () => laterRemove++);

    const entity = world.spawn([LifecycleProbe({ value: 1 })]);
    expect(laterAdd).toBe(1);
    expect(() => world.removeComponent(entity, LifecycleProbe)).not.toThrow();
    expect(laterRemove).toBe(1);
    expect(world.hasComponent(entity, LifecycleProbe)).toBe(false);
    errorSpy.mockRestore();
  });

  it("Scenario: Given an onRemove hook that re-enters the same removal——When removed——Then onRemove fires exactly once", () => {
    const world = new World();
    const entity = world.spawn([LifecycleProbe({ value: 1 })]);
    let calls = 0;
    world.onRemove(LifecycleProbe, () => {
      calls++;
      world.removeComponent(entity, LifecycleProbe);
    });

    world.removeComponent(entity, LifecycleProbe);

    expect(calls).toBe(1);
    expect(world.hasComponent(entity, LifecycleProbe)).toBe(false);
  });
});

describe("Feature: P0 QueryState change readers", () => {
  const QueryProbe = defineComponent("p0QueryStateProbe", {
    value: f.num().default(0),
  });

  it("Scenario: Given two persistent readers——When one consumes Changed——Then the other still observes the change", () => {
    const world = new World();
    const entity = world.spawn([QueryProbe({ value: 1 })]);
    const first = world.query(QueryProbe).filter(Changed(QueryProbe)).withState(world.createQueryState());
    const second = world.query(QueryProbe).filter(Changed(QueryProbe)).withState(world.createQueryState());

    expect(first.entities()).toEqual([entity]);
    expect(second.entities()).toEqual([entity]);
    expect(first.entities()).toEqual([]);

    world.setComponent(entity, QueryProbe({ value: 2 }));
    expect(first.entities()).toEqual([entity]);
    expect(second.entities()).toEqual([entity]);
  });

  it("Scenario: Given two persistent readers——When Added is consumed by one——Then the other still observes it", () => {
    const world = new World();
    const entity = world.spawn([QueryProbe({ value: 1 })]);
    const first = world.query(QueryProbe).filter(Added(QueryProbe)).withState(world.createQueryState());
    const second = world.query(QueryProbe).filter(Added(QueryProbe)).withState(world.createQueryState());

    expect(first.entities()).toEqual([entity]);
    expect(second.entities()).toEqual([entity]);
  });

  it("Scenario: Given 1000 spawn/query/destroy cycles——When the caller retires entities——Then caller-owned QueryState forgets every destroyed entity", () => {
    const world = new World();
    const state = world.createQueryState();

    for (let i = 0; i < 1000; i++) {
      const entity = world.spawn([QueryProbe({ value: i })]);
      expect(world.query(QueryProbe).filter(Added(QueryProbe)).withState(state).entities()).toEqual([entity]);
      expect(world.query(QueryProbe).filter(Changed(QueryProbe)).withState(state).entities()).toEqual([entity]);
      expect(state.readAdded(entity, QueryProbe.kind)).toBeGreaterThan(0);
      expect(state.readChanged(entity, QueryProbe.kind)).toBeGreaterThan(0);

      world.destroy(entity);
      world.flushDestroyed();
      state.forget(entity);

      expect(state.readAdded(entity, QueryProbe.kind)).toBe(0);
      expect(state.readChanged(entity, QueryProbe.kind)).toBe(0);
      world.setCurrentObserver(null);
    }
  });
});

describe("Feature: P0 removed-component readers", () => {
  const RemovedProbe = defineComponent("p0RemovedProbe", {
    value: f.num().default(0),
  });

  it("Scenario: Given two observers——When a component is removed——Then both observers see it and each cursor is independent", () => {
    const world = new World();
    const entity = world.spawn([RemovedProbe({ value: 1 })]);
    const before = world.lastChangedTick(RemovedProbe.kind);
    world.removeComponent(entity, RemovedProbe);

    expect(world.lastChangedTick(RemovedProbe.kind)).toBeGreaterThan(before);

    world.setCurrentObserver("removed-a");
    expect(world.removed(RemovedProbe)).toEqual([entity]);
    expect(world.removed(RemovedProbe)).toEqual([]);

    world.setCurrentObserver("removed-b");
    expect(world.removed(RemovedProbe)).toEqual([entity]);
  });

  it("Scenario: Given entity destruction——When flushDestroyed completes——Then drainKilled reports it and removed() does not", () => {
    const world = new World();
    const entity = world.spawn([RemovedProbe({ value: 1 })]);
    world.destroy(entity);
    world.flushDestroyed();

    world.setCurrentObserver("destroyed-reader");
    expect(world.removed(RemovedProbe)).toEqual([]);
    expect(world.drainKilled()).toContain(entity);
  });

  it("Scenario: Given repeated remove/add/remove in one frame——When read——Then the entity is reported once", () => {
    const world = new World();
    const entity = world.spawn([RemovedProbe({ value: 1 })]);
    world.removeComponent(entity, RemovedProbe);
    world.addComponent(entity, RemovedProbe({ value: 2 }));
    world.removeComponent(entity, RemovedProbe);

    world.setCurrentObserver("dedupe-reader");
    expect(world.removed(RemovedProbe)).toEqual([entity]);
  });

  it("Scenario: Given 系统排在移除者之前（本帧漏看）——When 下帧再读——Then 仍看到该移除（帧内排序无关）", () => {
    const world = new World();
    const entity = world.spawn([RemovedProbe({ value: 1 })]);

    // 帧 N：本系统先跑（此时尚无移除），移除者随后才 removeComponent。
    world.setCurrentObserver("early-reader");
    expect(world.removed(RemovedProbe)).toEqual([]);
    world.removeComponent(entity, RemovedProbe);
    world.setCurrentObserver(null); // 帧末轮转（引擎每帧都会做）

    // 帧 N+1：同一个系统先跑——双缓冲保证它仍能看到上一帧的移除。
    world.setCurrentObserver("early-reader");
    expect(world.removed(RemovedProbe)).toEqual([entity]);
    expect(world.removed(RemovedProbe)).toEqual([]);
  });

  it("Scenario: Given 移除已存活 2 帧——When 第 3 帧——Then 事件过期（有界内存）", () => {
    const world = new World();
    const entity = world.spawn([RemovedProbe({ value: 1 })]);
    world.removeComponent(entity, RemovedProbe);

    world.setCurrentObserver(null); // 帧 N 末：移除进入 prev
    world.setCurrentObserver(null); // 帧 N+1 末：无新移除 → 淘汰
    world.setCurrentObserver("late-reader");

    expect(world.removed(RemovedProbe)).toEqual([]);
  });

  it("Scenario: Given 跨帧 remove → add → remove——Then 同一读者按序各消费一次（同帧去重集合随帧轮转清空）", () => {
    const world = new World();
    const entity = world.spawn([RemovedProbe({ value: 1 })]);
    world.removeComponent(entity, RemovedProbe);

    world.setCurrentObserver("cross-frame-reader");
    expect(world.removed(RemovedProbe)).toEqual([entity]);
    world.setCurrentObserver(null); // 帧 N 末轮转：移除移入 prev，各 observer 游标平移

    world.addComponent(entity, RemovedProbe({ value: 2 }));
    world.removeComponent(entity, RemovedProbe);

    // 帧 N+1：同一读者已消费第一次移除，只看到第二次——若 seen 不随帧轮转清空，这里会漏。
    world.setCurrentObserver("cross-frame-reader");
    expect(world.removed(RemovedProbe)).toEqual([entity]);
    expect(world.removed(RemovedProbe)).toEqual([]);
  });

  it("Scenario: Given 无游标的读者在窗口第二帧入场——When 读——Then 看到窗口内两次移除（Bevy 事件存活 2 帧）", () => {
    const world = new World();
    const entity = world.spawn([RemovedProbe({ value: 1 })]);
    world.removeComponent(entity, RemovedProbe);
    world.setCurrentObserver(null); // 帧 N 末轮转：移除进入 prev

    world.addComponent(entity, RemovedProbe({ value: 2 }));
    world.removeComponent(entity, RemovedProbe);

    // 全新读者从未消费过窗口内事件，因此两条（prev 的第一次 + 本帧的第二次）都可见。
    world.setCurrentObserver("late-joiner");
    expect(world.removed(RemovedProbe)).toEqual([entity, entity]);
    expect(world.removed(RemovedProbe)).toEqual([]);
  });
});

describe("Feature: P0 mutation-safe query iteration", () => {
  const IteratorProbe = defineComponent("p0IteratorProbe", {
    value: f.num().default(0),
  });
  const AddedDuringIteration = defineComponent("p0AddedDuringIteration", {
    value: f.num().default(0),
  });

  it("Scenario: Given multiple entities——When the callback adds a component to each——Then every row is visited once", () => {
    const world = new World();
    const entities = Array.from({ length: 8 }, (_, value) => world.spawn([IteratorProbe({ value })]));
    const visited: number[] = [];

    world.queryMut(IteratorProbe).forEach((_component, entity) => {
      visited.push(entity);
      world.addComponent(entity, AddedDuringIteration({ value: entity }));
    });

    expect(visited).toEqual(entities);
    expect(new Set(visited).size).toBe(entities.length);
    expect(world.query(AddedDuringIteration).entities()).toHaveLength(entities.length);
  });

  it("Scenario: Given an existing destination archetype——When the callback moves rows there——Then the query-level snapshot neither skips nor duplicates", () => {
    const world = new World();
    const sources = Array.from({ length: 3 }, (_, value) => world.spawn([IteratorProbe({ value })]));
    const destination = world.spawn([IteratorProbe({ value: 99 }), AddedDuringIteration({ value: 99 })]);
    const visited: number[] = [];

    world.queryMut(IteratorProbe).forEach((_component, entity) => {
      visited.push(entity);
      if (!world.hasComponent(entity, AddedDuringIteration)) {
        world.addComponent(entity, AddedDuringIteration({ value: entity }));
      }
    });

    expect(visited).toEqual([...sources, destination]);
    expect(new Set(visited).size).toBe(visited.length);
  });

  it("Scenario: Given queryMut with filter and withState——When chained——Then mutation-safe snapshot mode is preserved", () => {
    const world = new World();
    const sources = Array.from({ length: 3 }, (_, value) => world.spawn([IteratorProbe({ value })]));
    const destination = world.spawn([IteratorProbe({ value: 99 }), AddedDuringIteration({ value: 99 })]);
    const state = world.createQueryState();
    const visited: number[] = [];

    world
      .queryMut(IteratorProbe)
      .filter(Changed(IteratorProbe))
      .withState(state)
      .forEach((_component, entity) => {
        visited.push(entity);
        world.addComponent(entity, AddedDuringIteration({ value: entity }));
      });

    expect(visited).toEqual([...sources, destination]);
    expect(new Set(visited).size).toBe(visited.length);
  });

});
