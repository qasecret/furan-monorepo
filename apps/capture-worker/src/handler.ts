import type { CaptureJob } from "@furan/queue";
import type { Telemetry } from "@furan/telemetry";

type Logger = Telemetry["logger"];

export async function handleCaptureJob(
  data: CaptureJob,
  logger: Logger,
): Promise<void> {
  logger.info(
    {
      jobType: "capture",
      projectId: data.projectId,
      runId: data.runId,
      browser: data.browser,
      viewport: data.viewport,
    },
    "capture_handler_noop",
  );
  // Phase 2: Playwright launch + screenshot + storage.put.
}
