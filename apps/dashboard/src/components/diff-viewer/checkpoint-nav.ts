/**
 * The next checkpoint AFTER `currentId` whose status still needs review
 * (`"unresolved"`), or null if none remain (forward-only; no wrap). Powers
 * the post-approve/reject auto-advance triage loop.
 */
export function nextUnresolvedCheckpointId(
  summaries: { id: string; status: string }[],
  currentId: string,
): string | null {
  const idx = summaries.findIndex((c) => c.id === currentId);
  if (idx === -1) return null;
  for (let i = idx + 1; i < summaries.length; i++) {
    if (summaries[i]!.status === "unresolved") return summaries[i]!.id;
  }
  return null;
}
