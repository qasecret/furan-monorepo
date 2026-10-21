import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The scratch and seed tests (run only when SCALE_DATABASE_URL is set) all
    // take the one `furan_scale` advisory lock; run files one at a time so
    // they never see each other as a concurrent scale run.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
