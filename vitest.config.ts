import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 测试跑源码（而不是 dist）：`@learnvis/ecs` 的包内自引用在 Node 侧按 exports
// 解析到 dist，未构建时会失败——这里显式别名回 src，保证「先测后构建」。
// dist 的真实可导入性由 CI 的 pack smoke（构建后从 tarball 导入）单独验证。
export default defineConfig({
  resolve: {
    alias: {
      "@learnvis/ecs": fileURLToPath(new URL("./src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["__tests__/**/*.test.ts"],
  },
});
