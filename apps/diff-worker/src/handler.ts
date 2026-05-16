import type { DiffJob } from "@furan/queue";
import type { Telemetry } from "@furan/telemetry";

type Logger = Telemetry["logger"];

export async function handleDiffJob(
  data: DiffJob,
  logger: Logger,
): Promise<void> {
  logger.info(
    {
      jobType: "diff",
      projectId: data.projectId,
      runId: data.runId,
      baselineKey: data.baselineKey,
      candidateKey: data.candidateKey,
    },
    "diff_handler_noop",
  );
  // Phase 2: storage.get(baseline) + storage.get(candidate) + odiff + storage.put(overlay).
}
