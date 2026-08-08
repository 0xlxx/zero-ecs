// packages/ecs/scripts/mutate-change-filter.ts — 变异测试（Changed/Added 按 kind 精确判断）
//
// 针对 world.ts 的语义破坏变异点（P2-03：masterChanged 快路径移除后）——
// 逐个应用 → 跑 change-filter.test.ts → killed/survived。
// 用法：bun run scripts/mutate-change-filter.ts

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "src/world.ts";
const TEST = "__tests__/change-filter.test.ts";

const mutants = [
  {
    name: "Changed lastSeen 串用首个 filter（跨 kind 干扰回归——forEach 路径）",
    old: "const lastSeen = w._getLastSeenChanged(\n                        e,\n                        changedFilters[fi].factory.kind,\n                      );",
    next: "const lastSeen = w._getLastSeenChanged(\n                        e,\n                        changedFilters[0].factory.kind,\n                      );",
  },
  {
    name: "first() 恢复忽略行级过滤器（直接返回首个实体）",
    old: "const hasRowFilters = changedFilters.length > 0 || addedFilters.length > 0;\n            for (const archId of candidate) {\n              const arch = w._archetypes.get(archId)!;\n              const ents = arch.entities;\n              // 行级过滤器（Changed/Added）——first() 也必须遵守（回归：此前直接返回首个实体）",
    next: "const hasRowFilters = false;\n            for (const archId of candidate) {\n              const arch = w._archetypes.get(archId)!;\n              const ents = arch.entities;\n              // 行级过滤器（Changed/Added）——first() 也必须遵守（回归：此前直接返回首个实体）",
  },
];

const original = readFileSync(FILE, "utf8");
const results = [];

for (const m of mutants) {
  if (!original.includes(m.old)) {
    results.push({ name: m.name, status: "NOT-APPLIED" });
    continue;
  }
  writeFileSync(FILE, original.replace(m.old, m.next));
  try {
    execSync(`bun vitest run ${TEST}`, { stdio: "pipe", timeout: 120_000, cwd: "." });
    results.push({ name: m.name, status: "SURVIVED" });
  } catch {
    results.push({ name: m.name, status: "KILLED" });
  }
  writeFileSync(FILE, original);
}

console.table(results);
const killed = results.filter((r) => r.status === "KILLED").length;
const survived = results.filter((r) => r.status === "SURVIVED").length;
console.log(
  `\\n变异结果: ${killed} killed / ${survived} survived / ${results.length - killed - survived} not-applied`,
);
process.exit(survived > 0 ? 1 : 0);
