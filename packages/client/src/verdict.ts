import type { ResultStatus, Run } from "./types.js";

/**
 * A settled run's verdict (spec §4.6). A first run whose baseline the server
 * auto-seeded counts as passed; a status this client doesn't know counts as
 * failed, so a newer server can never turn a problem into a pass.
 */
export function toResultStatus(
  run: Pick<Run, "status" | "autoApproved">,
): "passed" | "new" | "failed" {
  switch (run.status) {
    case "passed":
    case "empty":
      return "passed";
    case "new":
      return run.autoApproved ? "passed" : "new";
    default:
      return "failed";
  }
}

/**
 * Whether a result lets CI stay green. `new` (no baseline yet) passes unless
 * `failOnNew` (ADR-080's deliberate difference from the Kotlin SDK).
 */
export function isPassing(status: ResultStatus, failOnNew: boolean): boolean {
  switch (status) {
    case "passed":
    case "uploaded":
    case "skipped":
      return true;
    case "new":
      return !failOnNew;
    default:
      return false;
  }
}
