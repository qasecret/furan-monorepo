import { createHash, randomBytes } from "node:crypto";

import { expect, test } from "@playwright/test";
import sharp from "sharp";

import { ApiClient } from "../../src/clients/api-client.js";
import { pollRunStatus } from "../../src/clients/virtual-sdk.js";
import { coverAnnotations } from "../../src/coverage/reporter.js";
import { DASH_URL as DASH } from "../../src/env.js";
import { ownerCreds } from "../../src/seed/load-seed.js";

const MIB = 1024 * 1024;

/** Random-noise RGB PNG: incompressible, so 1024×768 encodes to ~2.3 MiB. */
async function noisePng(width: number, height: number): Promise<Buffer> {
  return sharp(randomBytes(width * height * 3), {
    raw: { width, height, channels: 3 },
  })
    .png()
    .toBuffer();
}

/**
 * On the single-origin deploy (furan-compose.yml) the api is not published:
 * SDK/CI clients upload through nginx under /api/. nginx caps request bodies
 * at 1 MB by default and answers 413 itself, before the api sees the request,
 * so a full-page screenshot never lands unless the /api/ location lifts the cap
 * to the api's own 50 MiB bodyLimit. This drives both SDK upload paths through
 * the proxy with a >1 MiB screenshot, then reads the stored bytes back.
 */
test.describe("deploy: single-origin proxy", () => {
  const api = new ApiClient(`${DASH}/api`);
  let admin = "";
  let pat = "";
  let projectId = "";

  test.beforeAll(async () => {
    ({ admin, pat } = ownerCreds());
    const project = await api.createProject(admin, {
      name: `e2e-proxy-upload-${Date.now()}`,
    });
    projectId = project.id;
  });

  for (const via of ["base64", "multipart"] as const) {
    test(`${via} upload of a >1 MiB screenshot passes the /api/ proxy`, async ({
      request,
    }, testInfo) => {
      testInfo.annotations.push(
        ...coverAnnotations(["deploy.proxy_large_upload"]),
      );
      const png = await noisePng(1024, 768);
      expect(png.length).toBeGreaterThan(MIB);

      const name = `large-${via}`;
      const build = await api.createBuild(pat, projectId, {
        branchName: "main",
      });
      const run = await api.createRun(pat, {
        projectId,
        buildId: build.id,
        name,
        branchName: "main",
      });
      const fields = { name, viewport: "1024x768", browser: "chromium" };
      if (via === "base64") {
        await api.uploadScreenshotBase64(pat, run.runId, {
          ...fields,
          pngBase64: png.toString("base64"),
        });
      } else {
        await api.uploadScreenshotMultipart(pat, run.runId, {
          ...fields,
          png,
        });
      }
      await api.completeRun(pat, run.runId);
      expect((await pollRunStatus(api, pat, run.runId)).status).toBe("new");

      // Content-addressed: the stored object is byte-identical to the upload,
      // so nginx relayed the whole body.
      const key = createHash("sha256").update(png).digest("hex");
      const res = await request.get(`${DASH}/api/api/v1/storage/${key}`, {
        headers: { authorization: `Bearer ${admin}` },
      });
      expect(res.status()).toBe(200);
      expect((await res.body()).equals(png)).toBe(true);
    });
  }
});
