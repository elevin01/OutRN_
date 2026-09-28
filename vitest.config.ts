import { defineConfig } from "vitest/config";

// Same as the CLI and API: time arithmetic assumes a UTC runtime.
process.env["TZ"] = "UTC";

export default defineConfig({
  resolve: { conditions: ["outrn-src"] },
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts", "packages/web/lib/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
