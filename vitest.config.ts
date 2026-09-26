import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["outrn-src"] },
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
