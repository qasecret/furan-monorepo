// SDK 1.0.x sent POST /runs with `name` interpreted as the checkpoint
// (not the test) name, plus viewport/browser/os/device on the same call.
// Under v1.1.0 those fields belong on POST /runs/:id/screenshots.
//
// This shim detects the legacy shape (any of viewport/browser/os/device
// present on POST /runs) and synthesizes a v1.1.0 test_runs row using
// `body.name` as the run name. SDK 1.0.x then POSTs screenshots with
// its old payload — the v1.1.0 screenshots route already accepts that
// shape because it requires `name` + `viewport` + `browser`.
//
// The stale-run sweeper (Phase 7.1) finalizes runs that don't get
// /complete because the v1.0.x SDK never sends it.

import { testRuns } from "@furan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

const legacyBody = z.object({
  projectId: z.string().uuid(),
  buildId: z.string().uuid(),
  name: z.string().min(1).max(255),
  branchName: z.string().min(1).max(255).optional(),
  viewport: z.string().optional(),
  browser: z.string().optional(),
  os: z.string().optional().nullable(),
  device: z.string().optional().nullable(),
});

export async function tryLegacyCreateRunSynthesis(
  app: FastifyInstance,
  req: FastifyRequest,
): Promise<{ runId: string; status: string; name: string } | null> {
  const parsed = legacyBody.safeParse(req.body);
  if (!parsed.success) return null;
  // Heuristic: presence of any legacy-only field on /runs.
  const isLegacy =
    parsed.data.viewport !== undefined ||
    parsed.data.browser !== undefined ||
    parsed.data.os !== undefined ||
    parsed.data.device !== undefined;
  if (!isLegacy) return null;

  const [row] = await app.db
    .insert(testRuns)
    .values({
      projectId: parsed.data.projectId,
      buildId: parsed.data.buildId,
      name: parsed.data.name, // best we can do without an explicit open()
      branchName: parsed.data.branchName ?? "main",
      status: "running",
    })
    .returning({
      id: testRuns.id,
      status: testRuns.status,
      name: testRuns.name,
    });
  if (!row) return null;
  return { runId: row.id, status: row.status, name: row.name };
}
