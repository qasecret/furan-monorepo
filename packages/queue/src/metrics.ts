/**
 * `furan_diff_jobs_enqueued_total{trigger}`: diff jobs handed to the diff
 * queue, by what triggered them. The api counts its own enqueues (an upload,
 * an ignore-area change, ...) and the diff worker its re-queues (`reconcile`).
 * Each registers it on its own registry, told apart there by the `service`
 * label, from this one definition so that the two can never drift apart.
 * `trigger` is a small closed set, never an id.
 */
export const DIFF_JOBS_ENQUEUED_METRIC = {
  name: "furan_diff_jobs_enqueued_total",
  help: "Diff jobs handed to the diff queue, by what triggered them",
  labelNames: ["trigger"],
} as const;
