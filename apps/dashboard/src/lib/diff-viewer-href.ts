/**
 * Route to the diff viewer for a run. The viewer is keyed by (runId, diffId);
 * for a row/preview-level open we pass runId in both segments — the viewer
 * redirects to the run's first diff when they don't match an exact diff record.
 */
export function diffViewerHref(projectId: string, runId: string): string {
  return `/projects/${projectId}/runs/${runId}/diffs/${runId}`;
}
