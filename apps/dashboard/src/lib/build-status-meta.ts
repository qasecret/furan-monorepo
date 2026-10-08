import { statusStyle } from "@/lib/status-style";

/**
 * Presentation of a build's aggregate status for the list surfaces: the
 * batch-history panel (build-list-item) and the inbox Batches table. A thin
 * adapter over `statusStyle`, the only status → style map, so both surfaces
 * (and every other status display) stay identical.
 */
export interface BuildStatusMeta {
  word: string;
  /** Text-colour class for the status word (history-panel + result rows). */
  text: string;
  /** `border-l-*` colour class for the history-panel row accent. */
  border: string;
  /** Tinted-pill classes for the Batches table (bg + text + border). */
  pill: string;
  /** `bg-*` colour for the status dot / left accent bar (result rows, cards). */
  dot: string;
}

export function buildStatusMeta(status: string): BuildStatusMeta {
  const s = statusStyle(status);
  return {
    word: s.label,
    text: s.text,
    border: s.accent,
    pill: s.pill,
    dot: s.dot,
  };
}
