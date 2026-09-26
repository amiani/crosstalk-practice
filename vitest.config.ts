import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PostgreSQL suites share one test database.
    fileParallelism: false,
    include: ["src/**/*.test.ts", "tools/**/*.test.ts"],
    root: ".",
  },
});
