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

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { World } from '@learnvis/ecs';
import type { Entity, System, ComponentOf, DataOf } from '@learnvis/ecs';

// ── Helpers ──

function makePosition(x: number, y: number, z: number): ComponentOf<'position3'> {
  return { type: 'position3', x, y, z };
}

function makeAppearance(overrides?: Partial<DataOf<'appearance'>>): ComponentOf<'appearance'> {
  return {
    type: 'appearance',
    color: overrides?.color ?? 0xff0000,
    opacity: overrides?.opacity ?? 1,
    wireframe: overrides?.wireframe ?? false,
    emissive: overrides?.emissive ?? 0,
  };
}

function makeUserId(id: string): ComponentOf<'userId'> {
  return { type: 'userId', value: id };
}

function makeLabel(text: string): ComponentOf<'label'> {
  return { type: 'label', text, offset: [0, 0.5, 0] };
}

function makeThickness(v: number): ComponentOf<'thickness'> {
  return { type: 'thickness', value: v };
}

// ════════════════════════════════════════════════
// 1. Entity lifecycle
// ════════════════════════════════════════════════

describe('Entity lifecycle', () => {
  let w: World;

  beforeEach(() => { w = new World(); });

  it('spawn() returns unique branded numbers', () => {
    const a = w.spawn();
    const b = w.spawn();
    expect(a).not.toBe(b);
    // branded — not plain number
    expect(typeof a).toBe('number');
    expect(typeof b).toBe('number');
  });

  it('isAlive() is true after spawn, false after destroy', () => {
    const e = w.spawn();
    expect(w.isAlive(e)).toBe(true);
    w.destroy(e);
    expect(w.isAlive(e)).toBe(false);
  });

  it('isAlive() returns false for unknown entities', () => {
    expect(w.isAlive(999 as Entity)).toBe(false);
    expect(w.isAlive(-1 as Entity)).toBe(false);
  });

  it('destroy() is idempotent', () => {
    const e = w.spawn();
    w.destroy(e);
    expect(() => w.destroy(e)).not.toThrow();
    expect(w.isAlive(e)).toBe(false);
  });

  it('destroy() on unknown entity does not throw', () => {
    expect(() => w.destroy(999 as Entity)).not.toThrow();
  });
});

// ════════════════════════════════════════════════
// 2. Component CRUD
// ════════════════════════════════════════════════

describe('Component CRUD', () => {
  let w: World;

  beforeEach(() => { w = new World(); });

  // ── addComponent ──

  it('addComponent() attaches data, getComponent() retrieves it', () => {
    const e = w.spawn();
    w.addComponent(e, makePosition(1, 2, 3));
    const pos = w.getComponent(e, 'position3');
    expect(pos).toBeDefined();
    expect(pos!.x).toBe(1);
    expect(pos!.y).toBe(2);
    expect(pos!.z).toBe(3);
  });

  it('addComponent() throws on duplicate kind', () => {
    const e = w.spawn();
    w.addComponent(e, makePosition(0, 0, 0));
    expect(() => w.addComponent(e, makePosition(1, 1, 1))).toThrow(
      /already has component/
    );
  });

  it('addComponent() silently no-ops on dead entity', () => {
    const e = w.spawn();
    w.destroy(e);
    expect(() => w.addComponent(e, makePosition(0, 0, 0))).not.toThrow();
    expect(w.getComponent(e, 'position3')).toBeUndefined();
  });

  // ── setComponent (upsert) ──

  it('setComponent() creates if absent, replaces if present', () => {
    const e = w.spawn();
    // First call: create
    w.setComponent(e, makePosition(1, 0, 0));
    expect(w.getComponent(e, 'position3')!.x).toBe(1);
    // Second call: replace
    w.setComponent(e, makePosition(2, 0, 0));
    expect(w.getComponent(e, 'position3')!.x).toBe(2);
  });

  it('setComponent() silently no-ops on dead entity', () => {
    const e = w.spawn();
    w.destroy(e);
    w.setComponent(e, makePosition(0, 0, 0));
    expect(w.getComponent(e, 'position3')).toBeUndefined();
  });

  // ── getComponent ──

  it('getComponent() returns undefined for missing kind', () => {
    const e = w.spawn();
    expect(w.getComponent(e, 'position3')).toBeUndefined();
    expect(w.getComponent(e, 'label')).toBeUndefined();
  });

  it('getComponent() returns undefined for dead entity', () => {
    const e = w.spawn();
    w.addComponent(e, makePosition(0, 0, 0));
    w.destroy(e);
    expect(w.getComponent(e, 'position3')).toBeUndefined();
  });

  // ── hasComponent ──

  it('hasComponent() returns correct boolean', () => {
    const e = w.spawn();
    expect(w.hasComponent(e, 'position3')).toBe(false);
    w.addComponent(e, makePosition(0, 0, 0));
    expect(w.hasComponent(e, 'position3')).toBe(true);
    expect(w.hasComponent(e, 'label')).toBe(false);
  });

  // ── removeComponent ──

  it('removeComponent() deletes the component', () => {
    const e = w.spawn();
    w.addComponent(e, makePosition(0, 0, 0));
    w.removeComponent(e, 'position3');
    expect(w.hasComponent(e, 'position3')).toBe(false);
    expect(w.getComponent(e, 'position3')).toBeUndefined();
  });

  it('removeComponent() on missing kind does not throw', () => {
    const e = w.spawn();
    expect(() => w.removeComponent(e, 'position3')).not.toThrow();
  });

  // ── patchComponent ──

  it('patchComponent() merges into existing component', () => {
    const e = w.spawn();
    w.addComponent(e, makePosition(1, 2, 3));
    w.patchComponent(e, 'position3', { x: 10 });
    const pos = w.getComponent(e, 'position3')!;
    expect(pos.x).toBe(10);
    expect(pos.y).toBe(2); // preserved
    expect(pos.z).toBe(3); // preserved
  });

  it('patchComponent() creates from defaults when absent', () => {
    const e = w.spawn();
    w.patchComponent(e, 'position3', { x: 5 });
    const pos = w.getComponent(e, 'position3')!;
    expect(pos.x).toBe(5);
    expect(pos.y).toBe(0); // default
    expect(pos.z).toBe(0); // default
  });

  it('patchComponent() silently no-ops on dead entity', () => {
    const e = w.spawn();
    w.destroy(e);
    expect(() => w.patchComponent(e, 'position3', { x: 1 })).not.toThrow();
    expect(w.getComponent(e, 'position3')).toBeUndefined();
  });

  it('patchComponent() preserves unrelated components', () => {
    const e = w.spawn();
    w.addComponent(e, makePosition(0, 0, 0));
    w.addComponent(e, makeAppearance());
    w.patchComponent(e, 'position3', { x: 99 });
    expect(w.getComponent(e, 'appearance')).toBeDefined();
    expect(w.getComponent(e, 'position3')!.x).toBe(99);
  });
});

// ════════════════════════════════════════════════
// 3. Query
// ════════════════════════════════════════════════

describe('Query', () => {
  let w: World;

  beforeEach(() => { w = new World(); });

  it('query() with single kind returns matching entities', () => {
    const a = w.spawn(); w.addComponent(a, makePosition(0, 0, 0));
    const b = w.spawn(); w.addComponent(b, makePosition(1, 1, 1));
    const c = w.spawn(); // no position
    const results = w.query('position3');
    expect(results).toHaveLength(2);
    expect(results).toContain(a);
    expect(results).toContain(b);
    expect(results).not.toContain(c);
  });

  it('query() with multiple kinds returns intersection', () => {
    const a = w.spawn(); w.addComponent(a, makePosition(0, 0, 0)); w.addComponent(a, makeAppearance());
    const b = w.spawn(); w.addComponent(b, makePosition(1, 1, 1)); // no appearance
    const c = w.spawn(); w.addComponent(c, makeAppearance()); // no position
    const results = w.query('position3', 'appearance');
    expect(results).toHaveLength(1);
    expect(results[0]).toBe(a);
  });

  it('query() returns empty array when no entities match', () => {
    const results = w.query('position3');
    expect(results).toEqual([]);
  });

  it('query() excludes destroyed entities', () => {
    const a = w.spawn(); w.addComponent(a, makePosition(0, 0, 0));
    const b = w.spawn(); w.addComponent(b, makePosition(1, 1, 1));
    expect(w.query('position3')).toHaveLength(2);
    w.destroy(a);
    expect(w.query('position3')).toHaveLength(1);
    expect(w.query('position3')[0]).toBe(b);
  });

  it('query() with zero kinds returns empty array', () => {
    const a = w.spawn(); w.addComponent(a, makePosition(0, 0, 0));
    expect(w.query()).toEqual([]);
  });
});

// ════════════════════════════════════════════════
// 4. UserId index
// ════════════════════════════════════════════════

describe('UserId index', () => {
  let w: World;

  beforeEach(() => { w = new World(); });

  it('entityByUserId() finds entity by userId component', () => {
    const e = w.spawn();
    w.addComponent(e, makeUserId('my-point'));
    expect(w.entityByUserId('my-point')).toBe(e);
  });

  it('entityByUserId() returns undefined for unknown id', () => {
    expect(w.entityByUserId('nope')).toBeUndefined();
  });

  it('entityByUserId() works with setComponent (upsert)', () => {
    const e = w.spawn();
    w.setComponent(e, makeUserId('vec-A'));
    expect(w.entityByUserId('vec-A')).toBe(e);
    w.setComponent(e, makeUserId('vec-B'));
    expect(w.entityByUserId('vec-A')).toBeUndefined();
    expect(w.entityByUserId('vec-B')).toBe(e);
  });

  it('entityByUserId() cleared on destroy', () => {
    const e = w.spawn();
    w.addComponent(e, makeUserId('temp'));
    w.destroy(e);
    expect(w.entityByUserId('temp')).toBeUndefined();
  });

  it('entityByUserId() cleared on removeComponent of userId', () => {
    const e = w.spawn();
    w.addComponent(e, makeUserId('rm-me'));
    w.removeComponent(e, 'userId');
    expect(w.entityByUserId('rm-me')).toBeUndefined();
  });

  it('entityByUserId() tracks the latest entity for a given id', () => {
    // Same-id reuse pattern: destroy old, spawn new
    const a = w.spawn(); w.addComponent(a, makeUserId('dup'));
    w.destroy(a);
    const b = w.spawn(); w.addComponent(b, makeUserId('dup'));
    expect(w.entityByUserId('dup')).toBe(b);
  });
});

// ════════════════════════════════════════════════
// 5. System
// ════════════════════════════════════════════════

describe('System', () => {
  let w: World;

  beforeEach(() => { w = new World(); });

  it('addSystem() registers, update() executes systems in registration order', () => {
    const order: string[] = [];
    const sysA: System = {
      name: 'A', requiredComponents: [],
      update() { order.push('A'); },
    };
    const sysB: System = {
      name: 'B', requiredComponents: [],
      update() { order.push('B'); },
    };
    w.addSystem(sysA);
    w.addSystem(sysB);
    w.update(null);
    expect(order).toEqual(['A', 'B']);
  });

  it('system receives world and context in update()', () => {
    let capturedWorld: any = null;
    let capturedCtx: any = null;
    const sys: System = {
      name: 'capture', requiredComponents: [],
      update(world, ctx) { capturedWorld = world; capturedCtx = ctx; },
    };
    w.addSystem(sys);
    const ctx = { dt: 0.016 };
    w.update(ctx);
    expect(capturedWorld).toBe(w);
    expect(capturedCtx).toBe(ctx);
  });

  it('requiredComponents is accessible for introspection', () => {
    const sys: System = {
      name: 'render',
      requiredComponents: ['position3', 'geometry', 'appearance'] as const,
      update() {},
    };
    expect(sys.requiredComponents).toContain('position3');
    expect(sys.requiredComponents).toContain('geometry');
    expect(sys.requiredComponents).toContain('appearance');
  });

  it('system can read and write components during update', () => {
    const sys: System = {
      name: 'init-size',
      requiredComponents: ['position3'],
      update(world) {
        for (const e of world.query('position3')) {
          if (!world.hasComponent(e, 'size')) {
            world.patchComponent(e, 'size', { value: 10 });
          }
        }
      },
    };
    w.addSystem(sys);
    const e = w.spawn();
    w.addComponent(e, makePosition(0, 0, 0));
    w.update(null);
    expect(w.getComponent(e, 'size')!.value).toBe(10);
  });
});

// ════════════════════════════════════════════════
// 6. Edge cases & invariants
// ════════════════════════════════════════════════

describe('Edge cases', () => {
  it('spawn → add → query → patch → destroy cycle works correctly', () => {
    const w = new World();
    const e = w.spawn();
    w.addComponent(e, makePosition(0, 0, 0));
    w.addComponent(e, makeAppearance({ color: 0x00ff00 }));
    w.addComponent(e, makeUserId('test-entity'));

    expect(w.query('position3', 'appearance', 'userId')).toEqual([e]);
    expect(w.entityByUserId('test-entity')).toBe(e);

    w.patchComponent(e, 'appearance', { opacity: 0.5 });
    expect(w.getComponent(e, 'appearance')!.opacity).toBe(0.5);

    w.destroy(e);
    expect(w.query('position3')).toEqual([]);
    expect(w.entityByUserId('test-entity')).toBeUndefined();
    expect(w.isAlive(e)).toBe(false);
  });

  it('multiple entities with interleaved component sets query correctly', () => {
    const w = new World();
    const a = w.spawn(); w.addComponent(a, makePosition(0, 0, 0));
    const b = w.spawn(); w.addComponent(b, makePosition(1, 1, 1)); w.addComponent(b, makeLabel('B'));
    const c = w.spawn(); w.addComponent(c, makeLabel('C'));

    expect(w.query('position3')).toEqual([a, b]);
    expect(w.query('label')).toEqual([b, c]);
    expect(w.query('position3', 'label')).toEqual([b]);
    expect(w.query('position3', 'label', 'userId')).toEqual([]);
  });

  it('World instances are independent', () => {
    const w1 = new World();
    const w2 = new World();
    const e1 = w1.spawn(); w1.addComponent(e1, makePosition(0, 0, 0));
    const e2 = w2.spawn(); w2.addComponent(e2, makePosition(1, 1, 1));

    expect(w1.query('position3')).toHaveLength(1);
    expect(w2.query('position3')).toHaveLength(1);
    expect(w1.isAlive(e2)).toBe(false); // cross-world entity
  });

  it('spawn returns incrementing IDs', () => {
    const w = new World();
    const ids = Array.from({ length: 5 }, () => w.spawn());
    const unique = new Set(ids);
    expect(unique.size).toBe(5);
  });

  it('destroy+respawn correctly reuses index entries', () => {
    const w = new World();
    const a = w.spawn(); w.addComponent(a, makeUserId('P'));
    w.destroy(a);
    const b = w.spawn(); w.addComponent(b, makeUserId('P'));
    expect(w.entityByUserId('P')).toBe(b);
    expect(w.entityByUserId('P')).not.toBe(a);
  });
});

// ════════════════════════════════════════════════
// 7. Rebuild avoidance — entity reuse patterns
// ════════════════════════════════════════════════

describe('Rebuild avoidance', () => {
  it('setComponent does not change entity identity', () => {
    const w = new World();
    const e = w.spawn();
    w.addComponent(e, makePosition(0, 0, 0));
    w.addComponent(e, makeUserId('vec-v'));

    w.setComponent(e, makePosition(10, 20, 30));

    expect(w.isAlive(e)).toBe(true);
    expect(w.entityByUserId('vec-v')).toBe(e);
    expect(w.getComponent(e, 'position3')!.x).toBe(10);
  });

  it('patchComponent does not change entity identity', () => {
    const w = new World();
    const e = w.spawn();
    w.addComponent(e, makePosition(1, 2, 3));
    w.addComponent(e, makeUserId('obj-X'));

    w.patchComponent(e, 'position3', { y: 99 });
    w.patchComponent(e, 'position3', { z: 42 });

    expect(w.isAlive(e)).toBe(true);
    expect(w.entityByUserId('obj-X')).toBe(e);
    const pos = w.getComponent(e, 'position3')!;
    expect(pos.x).toBe(1);   // untouched
    expect(pos.y).toBe(99);  // patched
    expect(pos.z).toBe(42);  // patched
  });

  it('same-id reuse: destroy old, spawn new, component data updates', () => {
    // Simulates the scene.ts same-id reuse path:
    //   _upsert(id) → destroy old → spawn new → addComponent
    const w = new World();
    const a = w.spawn(); w.addComponent(a, makeUserId('P')); w.addComponent(a, makePosition(0, 0, 0));
    expect(w.entityByUserId('P')).toBe(a);

    w.destroy(a);
    const b = w.spawn(); w.addComponent(b, makeUserId('P')); w.addComponent(b, makePosition(5, 5, 5));

    expect(w.entityByUserId('P')).toBe(b);
    expect(w.isAlive(a)).toBe(false);
    expect(w.getComponent(b, 'position3')!.x).toBe(5);
    expect(w.query('position3')).toHaveLength(1);
  });

  it('query result count stable across setComponent updates', () => {
    const w = new World();
    const e = w.spawn();
    w.addComponent(e, makePosition(0, 0, 0));
    w.addComponent(e, makeAppearance());

    expect(w.query('position3', 'appearance')).toHaveLength(1);

    w.setComponent(e, makePosition(1, 1, 1)); // update
    expect(w.query('position3', 'appearance')).toHaveLength(1);

    w.setComponent(e, makeAppearance({ opacity: 0.5 })); // update
    expect(w.query('position3', 'appearance')).toHaveLength(1);
  });

  it('addComponent throws on duplicate — prevents accidental rebuild', () => {
    const w = new World();
    const e = w.spawn();
    w.addComponent(e, makePosition(0, 0, 0));

    // Double-add is a mistake — use setComponent instead
    expect(() => w.addComponent(e, makePosition(1, 1, 1)))
      .toThrow(/already has component/);

    // Correct: setComponent silently replaces
    w.setComponent(e, makePosition(1, 1, 1));
    expect(w.getComponent(e, 'position3')!.x).toBe(1);
  });

  it('geometric component swap preserves other components', () => {
    // When updating geometry (e.g. from sphere to cube), other
    // components like userId, position, label must survive.
    const w = new World();
    const e = w.spawn();
    w.addComponent(e, makeUserId('obj'));
    w.addComponent(e, makePosition(3, 3, 3));
    w.addComponent(e, makeLabel('test'));
    w.setComponent(e, { type: 'geometry', kind: 'sphere', radius: 2 } as any);

    // Swap geometry kind
    w.setComponent(e, { type: 'geometry', kind: 'cube', size: 4 } as any);

    expect(w.entityByUserId('obj')).toBe(e);
    expect(w.getComponent(e, 'position3')!.x).toBe(3);
    expect(w.getComponent(e, 'label')!.text).toBe('test');
    const geo = w.getComponent(e, 'geometry') as any;
    expect(geo.kind).toBe('cube');
    expect(geo.size).toBe(4);
  });
});

// ═══════════════════════════════════════════════════════════
// Frame lifecycle (enter/update/exit) — touched-set pattern
// ═══════════════════════════════════════════════════════════

describe('Frame lifecycle — touched-set pattern', () => {
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

  it('entity declared in frame survives sweep', () => {
    declare('a');
    const removed = sweep();
    expect(removed).toHaveLength(0);
    expect(store.has('a')).toBe(true);
  });

  it('entity not redeclared is destroyed on sweep', () => {
    declare('a');
    sweep(); touched.clear();
    const removed = sweep();
    expect(removed).toHaveLength(1);
    expect(store.has('a')).toBe(false);
  });

  it('entity with same id is updated not recreated', () => {
    const e1 = declare('a');
    sweep(); touched.clear();
    const e2 = declare('a');
    expect(e2).toBe(e1);
    expect(store.size).toBe(1);
    sweep();
    expect(store.has('a')).toBe(true);
  });

  it('mixed: new survive, untouched die, updated survive', () => {
    declare('keep');
    declare('update-me');
    sweep(); touched.clear();

    declare('keep');
    declare('update-me');
    declare('new-guy');
    expect(sweep()).toHaveLength(0);
    expect(store.size).toBe(3);
    touched.clear();

    declare('keep');
    declare('new-guy');
    const removed = sweep();
    expect(removed).toHaveLength(1);
    expect(store.has('update-me')).toBe(false);
    expect(store.has('keep')).toBe(true);
    expect(store.has('new-guy')).toBe(true);
  });

  it('step switching: step 1 entities die in step 2', () => {
    declare('step1-a');
    declare('step1-b');
    sweep(); touched.clear();

    declare('step2-x');
    declare('step2-y');
    const removed = sweep();
    expect(removed).toHaveLength(2);
    expect(store.size).toBe(2);
    expect(store.has('step2-x')).toBe(true);
    expect(store.has('step1-a')).toBe(false);
  });

  it('destroyed entity removed from world queries', () => {
    const e = declare('a');
    sweep(); touched.clear();
    sweep();
    expect(w.query('userId')).toHaveLength(0);
  });
});
