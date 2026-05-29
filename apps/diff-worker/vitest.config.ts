import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup-minio.ts"],
    testTimeout: 30000,
  },
});
