"use client";

import { useRef, useState, type KeyboardEvent } from "react";

import { useViewerStore } from "./useViewerStore";

import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";

const MAX_LEN = 10_000;

interface Props {
  runId: string;
  /**
   * Embedded mode: render inline inside the diff-viewer's INFO sidebar
   * COMMENTS tab. Skips the store-driven open gate and the Close button —
   * the parent tab controls visibility instead.
   */
  embedded?: boolean;
}

/**
 * Collapsible per-run comment editor.
 *
 * Reads the current value from the run header's query cache
 * (`runs.getById`, no extra fetch). Writes via `runs.setComment`. Save triggers: click the Save
 * button, or press Cmd/Ctrl+Enter inside the textarea. Empty/whitespace
 * input is normalized to `null` so saving an emptied textarea clears the
 * column.
 *
 * Keystrokes inside the textarea have their propagation stopped so the
 * dashboard's key dispatcher (e.g. the viewer's `A`/`R`/`C` commands from
 * `useDiffViewerShortcuts`) does not fire while the user is typing.
 *
 * The box holds the run's unsent draft when there is one, else its saved
 * comment, live (R25). The draft is the viewer store's, by run, so it
 * outlives this panel (a collapse, a tab switch, the ignore-region editor),
 * and Mark as Bug's note lands in it whether or not the panel is on screen;
 * a successful save drops it. There is nothing to rehydrate on mount.
 */
export function RunCommentPanel({ runId, embedded = false }: Props) {
  const open = useViewerStore((s) => s.commentPanelOpen);
  const setOpen = useViewerStore((s) => s.setCommentPanelOpen);
  const draft = useViewerStore((s) => s.commentDrafts[runId]);
  const setCommentDraft = useViewerStore((s) => s.setCommentDraft);
  const utils = trpc.useUtils();
  const { data } = trpc.runs.getById.useQuery({ runId });
  const serverValue = data?.comment ?? "";
  const value = draft ?? serverValue;

  const [error, setError] = useState<string | null>(null);
  // What the last save sent: its success drops the draft only if nothing was
  // typed since.
  const sent = useRef<string | null>(null);

  const setComment = trpc.runs.setComment.useMutation({
    onMutate: () => setError(null),
    onSuccess: (saved) => {
      // The saved comment into the cache first, so the box never shows the
      // old one between dropping the draft and the refetch.
      utils.runs.getById.setData({ runId }, (run) =>
        run ? { ...run, comment: saved.comment } : run,
      );
      if (useViewerStore.getState().commentDrafts[runId] === sent.current) {
        setCommentDraft(runId, null);
      }
      void utils.runs.getById.invalidate({ runId });
    },
    onError: (e) => setError(e.message),
  });

  if (!embedded && !open) return null;

  // A draft is what differs from the saved comment: typing back to it
  // leaves none.
  const edit = (next: string) =>
    setCommentDraft(runId, next === serverValue ? null : next);

  const save = () => {
    const trimmed = value.trim();
    const toSubmit = trimmed.length === 0 ? null : value;
    sent.current = value;
    setComment.mutate({ runId, comment: toSubmit });
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Suppress the global tinykeys binding for ALL keys typed in here.
    e.stopPropagation();
    // Cmd+Enter on mac, Ctrl+Enter elsewhere → save.
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      save();
    }
  };

  return (
    <div
      className={
        embedded ? "space-y-2" : "border-t border-edge bg-canvas p-3 space-y-2"
      }
      data-testid="comment-panel"
    >
      <div className="flex items-center justify-between">
        <label htmlFor="run-comment-textarea" className="text-sm font-medium">
          Comment
        </label>
        {!embedded && (
          <Button
            type="button"
            variant="secondary"
            className="px-2 py-1 text-xs"
            onClick={() => setOpen(false)}
            data-testid="comment-close-button"
          >
            Close
          </Button>
        )}
      </div>
      <textarea
        id="run-comment-textarea"
        value={value}
        onChange={(e) => edit(e.target.value)}
        onKeyDown={handleKeyDown}
        maxLength={MAX_LEN}
        rows={4}
        className="w-full rounded-md border border-edge bg-canvas px-3 py-2 text-sm font-mono text-fg placeholder:text-fg-muted focus-ring"
        placeholder="Notes on this run…"
        data-testid="comment-textarea"
      />
      <div className="flex items-center justify-between">
        <span className="text-xs tabular-nums text-fg-muted">
          {value.length} / {MAX_LEN}
          <span className="ml-2">(Cmd/Ctrl+Enter to save)</span>
        </span>
        <Button
          type="button"
          onClick={save}
          disabled={setComment.isPending}
          data-testid="comment-save-button"
        >
          {setComment.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
      {error && (
        <span
          role="alert"
          className="text-sm text-destructive"
          data-testid="comment-error"
        >
          {error}
        </span>
      )}
    </div>
  );
}
