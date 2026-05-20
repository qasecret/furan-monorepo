import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // All test files in this package share the same Postgres via `createDb()`
    // and many do FK-cascade deletes from `projects` in their beforeEach.
    // Vitest's default parallel forks let two files' beforeEach interleave:
    // file A inserts a project, file B's CASCADE delete (from a different
    // test) wipes it, file A's next insert (e.g. a test_variation referencing
    // the now-gone project) fails the FK constraint. Force serial execution
    // to match the api + diff-worker test configs. CI ran into this on PR #58.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/__test-fixtures__/**"],
    },
    testTimeout: 30000,
  },
});
