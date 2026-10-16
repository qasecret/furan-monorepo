import { ApiClient } from "../clients/api-client.js";

/**
 * Upload a sweep's screenshots as ONE build to a Furan instance, so a slice's
 * before/after can be reviewed in Furan's own diff viewer. Same REST sequence
 * as the virtual SDK's `capture()`: one createBuild, then per shot createRun →
 * uploadScreenshotBase64 → completeRun. No polling — the diff pipeline settles
 * the runs on its own and the reviewer looks at them later.
 *
 * Every upload must use the SAME `branch` (the label only names the build):
 * baselines are branch-scoped, so a `before` build approved on one branch is
 * invisible to an `after` build on another, and every shot would come back
 * "new" instead of diffed.
 *
 * Returns the build and, per shot in order, its run and its one checkpoint
 * (the visual fixture waits on and reviews them).
 */
export async function uploadShots(o: {
  apiUrl: string;
  pat: string;
  projectId: string;
  branch: string;
  buildName: string;
  shots: ReadonlyArray<{ name: string; png: Buffer }>;
}): Promise<{
  buildId: string;
  runs: Array<{ name: string; runId: string; checkpointId: string }>;
}> {
  const api = new ApiClient(o.apiUrl);
  const build = await api.createBuild(o.pat, o.projectId, {
    branchName: o.branch,
    name: o.buildName,
  });
  const runs: Array<{ name: string; runId: string; checkpointId: string }> = [];
  for (const shot of o.shots) {
    const run = await api.createRun(o.pat, {
      projectId: o.projectId,
      buildId: build.id,
      name: shot.name,
      branchName: o.branch,
    });
    const { checkpointId } = await api.uploadScreenshotBase64(
      o.pat,
      run.runId,
      {
        pngBase64: shot.png.toString("base64"),
        name: shot.name,
        viewport: "1440x900",
        browser: "chromium",
      },
    );
    await api.completeRun(o.pat, run.runId);
    runs.push({ name: shot.name, runId: run.runId, checkpointId });
  }
  return { buildId: build.id, runs };
}
