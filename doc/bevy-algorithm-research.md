# Bevy ECS Algorithm Optimizations for learnvis

Research date: 2025-06-25. Source: Bevy 0.18 ECS source + RFCs.

## 1. Query Archetype Caching (HIGH impact, low complexity)

### What Bevy does
`QueryState` caches matching archetypes in a `FixedBitset` + `Vec<StorageId>`. Uses an
`archetype_generation` counter to detect new archetypes since last query — only incremental
re-scan, never rebuild from scratch.

```rust
struct QueryState {
    matched_archetypes: FixedBitset,  // bit idx → archetype ID
    matched_tables: Vec<StorageId>,    // dense vec for fast iteration
    archetype_generation: u64,         // cache version
}

fn update_archetypes(&mut self, world: &World) {
    if world.archetypes().generation() == self.archetype_generation { return; }
    for arch in world.archetypes().new_since(self.archetype_generation) {
        if self.matches(arch) { self.matched_archetypes.set(arch.id()); }
    }
    self.archetype_generation = world.archetypes().generation();
}
```

### What learnvis currently does
Every `query()` call rebuilds the archetype intersection from scratch:
```typescript
let candidate: Set<number> | null = null;
for (const f of factories) {
  const archetypeMap = w._componentIndex.get(f.kind);
  if (candidate === null) candidate = new Set(archetypeMap.keys());
  else { for (const id of candidate) if (!archetypeMap.has(id)) candidate.delete(id); }
}
```

### Proposed implementation
```typescript
// In World:
private _archetypeGeneration = 0;

// In Query object (lazy-init):
private _cachedArchs: { archId: number; colIdxs: number[] }[] | null = null;
private _cachedGeneration = -1;

// On execution:
_ensureFresh() {
  if (this._cachedGeneration === w._archetypeGeneration) return;
  // Incremental: only scan archetypes newer than cache
  const newArchs = this._findNewMatchingArchs();
  this._cachedArchs.push(...newArchs);
  this._cachedGeneration = w._archetypeGeneration;
}
```

### Expected impact
- Eliminates per-call `new Set()` + Map iteration overhead
- Multi-archetype queries: 10-20% throughput improvement
- Query construction overhead drops from O(archetypes × factories) to O(new_archetypes × factories)
- ~zero overhead after all archetypes are created (steady state)

---

## 2. Sparse Set Storage (MEDIUM impact, medium complexity)

### What Bevy does
Two storage backends:
| Storage | Iteration | Add/Remove | Use case |
|---------|-----------|------------|----------|
| Table (archetype) | Fast, contiguous | Slow (row copy) | Frequently queried |
| SparseSet | Slower (indirection) | O(1) (no copy) | Frequently added/removed |

Developers choose per component. E.g., `Lifetime`, `Buff`, `Cooldown` go in SparseSet
because they're added/removed often but rarely queried.

### What learnvis currently does
ALL components are archetype-stored. Every `addComponent()` → archetype migration:
copy ALL component data from old archetype to new archetype (one `.get()` + `.push()` per column).

This is O(N) where N = number of components on the entity. For entities with 10+ components,
adding a `Buff` component copies 10 other columns unnecessarily.

### Proposed implementation
```typescript
// Per-component option:
defineComponent("buff", defaults, { storage: "sparse" });

// SparseSetColumn:
class SparseSetColumn {
  private _dense: Record<string, unknown>[] = [];
  private _sparse: Int32Array;  // entity index → dense index
  get(entity: Entity): Data { return this._dense[this._sparse[entityIndex(entity)]]; }
}

// In query: archetype matching IGNORES sparse components.
// Sparse components are looked up per-entity during iteration.
```

Tradeoff: SparseSet queries are ~2-3x slower for iteration (indirection), but add/remove
is O(1) and doesn't fragment archetypes. Worth it for components with high add/remove churn.

### Expected impact
- Eliminates archetype migration for hot components
- Reduces archetype count (less fragmentation)
- Useful for: `Lifetime`, `Buff`, `Cooldown`, `Tween*`, `Spring*`, `Wireframe`

---

## 3. Dense Iteration Fast Path (LOW impact, low complexity)

### What Bevy does
When all queried components are table-stored (no sparse components), use dense table
iteration: iterate table rows directly, skip archetype-level entity tracking.

### What we can do
When `_anyDestroysThisTick` is false AND the query matches exactly 1 archetype,
skip the `isAlive` check entirely and bypass entity array access:

```typescript
// Fast path: single archetype, no dead entities
for (let r = 0; r < data[0].length; r++) {
  s += data[0][r].x + data[1][r].dx;  // no isAlive, no entity lookup
}
```

Partially done via `_anyDestroysThisTick` flag. Can extend to detect single-archetype
case and use even tighter loops.

---

## 4. Commands / Deferred Operations Queue (LOW impact, medium complexity)

### What Bevy does
`Commands` queue entity mutations (spawn, despawn, insert, remove) that are applied
at the end of each system, not immediately. This:
- Prevents mid-iteration mutations (archetype invalidation)
- Enables batching: multiple mutations to same entity collapse
- Works naturally with parallel iteration

### What we currently do
Only `destroy()` is deferred (via `_deferredDestroys`). All other mutations are immediate.

### Proposed
```typescript
world.commands().insert(entity, component);
world.commands().remove(entity, factory);
// ... at end of system:
world.commands().apply();  // batch-apply all pending mutations
```

---

## 5. Component Lifecycle Hooks (LOW impact, low complexity)

### What Bevy does
`OnAdd<T>`, `OnInsert<T>`, `OnRemove<T>` — trigger observer systems when components change.
E.g., "when `Health` reaches 0, despawn entity" — without polling every frame.

### What we have
Only `onBeforeDestroy` hook.

### Proposed
```typescript
world.onAdd(Lifetime, (entity, data) => { /* started */ });
world.onRemove(Lifetime, (entity, data) => { /* expired */ });
```

---

## Priority & Implementation Order

| # | Optimization | Impact | Effort | Verdict |
|---|-------------|--------|--------|---------|
| 1 | Query archetype caching | HIGH | ~50 lines | **Do immediately** |
| 2 | Sparse set storage | MEDIUM | ~200 lines | **High-value, plan next** |
| 3 | Dense iteration fast path | LOW | ~20 lines | Quick win, piggyback on #1 |
| 4 | Deferred commands | LOW | ~150 lines | API improvement, not perf |
| 5 | Component hooks | LOW | ~100 lines | Reactive ergonomics |

---

## What NOT to adopt (JS-specific reasons)

- **Parallel iteration (rayon)**: JS is single-threaded. Web Workers have serialization overhead.
- **FixedBitset**: JS `Set<number>` is already efficient enough for archetype counts (<1000).
  Bitset would only matter at 10k+ archetypes, which is pathological.
- **Fetch/Store trait pattern**: Rust zero-cost abstraction. In JS, this would add vtable overhead.
  Use direct column access instead (our `rawData()` pattern is already optimal for JS).
- **SystemParam derive macro**: Rust compile-time magic. JS would need decorators, which add
  runtime cost. Our `world` + `context` parameters are equivalent and simpler.
