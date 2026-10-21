import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createQueue } from "../src/index.js";

const RUN = "00000000-0000-0000-0000-000000000001";
const PROJ = "00000000-0000-0000-0000-000000000002";
const rand = randomUUID().slice(0, 8);

describe.skipIf(!process.env.REDIS_URL)("createQueue key prefix", () => {
  it("isolates two queues with the same name by prefix", async () => {
    const a = createQueue("diff", { prefix: `furan-scale-test-${rand}` });
    const b = createQueue("diff");
    try {
      await a.add("diff", { runId: RUN, projectId: PROJ });
      expect((await a.getJobCounts("waiting")).waiting).toBe(1);
      expect(
        (await b.getJobs(["waiting"])).some((j) => j.data.runId === RUN),
      ).toBe(false);
    } finally {
      await a.obliterate({ force: true });
      await a.close();
      await b.close();
    }
  });
});
