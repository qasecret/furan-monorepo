"use client";

import { useEffect, useState, type KeyboardEvent } from "react";

import { useViewerStore } from "./useViewerStore";

import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";

const MAX_LEN = 10_000;

interface Props {
  runId: string;
}

/**
 * Collapsible per-run comment editor.
 *
 * Reads the current value from the `runs.getById` query cache (no extra
 * fetch). Writes via `runs.setComment`. Save triggers: click the Save
 * button, or press Cmd/Ctrl+Enter inside the textarea. Empty/whitespace
 * input is normalized to `null` so saving an emptied textarea clears the
 * column.
 *
 * Keystrokes inside the textarea have their propagation stopped so the
 * global `tinykeys` binding (e.g. the `A`/`R`/`C` shortcuts wired by
 * `useDiffViewerShortcuts`) does not fire while the user is typing.
 */
export function RunCommentPanel({ runId }: Props) {
  const open = useViewerStore((s) => s.commentPanelOpen);
  const setOpen = useViewerStore((s) => s.setCommentPanelOpen);
  const utils = trpc.useUtils();
  const { data } = trpc.runs.getById.useQuery({ runId });
  const serverValue = data?.comment ?? "";

  const [value, setValue] = useState(serverValue);
  const [error, setError] = useState<string | null>(null);

  // Rehydrate the textarea when the cached run row changes (e.g. after a
  // successful save invalidates the query). We do NOT depend on `open` —
  // local state stays in sync even when the panel is closed so reopening
  // shows the latest value immediately.
  useEffect(() => {
    setValue(serverValue);
  }, [serverValue]);

  const setComment = trpc.runs.setComment.useMutation({
    onMutate: () => setError(null),
    onSuccess: () => {
      void utils.runs.getById.invalidate({ runId });
    },
    onError: (e) => setError(e.message),
  });

  if (!open) return null;

  const save = () => {
    const trimmed = value.trim();
    const toSubmit = trimmed.length === 0 ? null : value;
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
      className="border-t bg-background p-3 space-y-2"
      data-testid="comment-panel"
    >
      <div className="flex items-center justify-between">
        <label htmlFor="run-comment-textarea" className="text-sm font-medium">
          Comment
        </label>
        <Button
          type="button"
          variant="secondary"
          className="px-2 py-1 text-xs"
          onClick={() => setOpen(false)}
          data-testid="comment-close-button"
        >
          Close
        </Button>
      </div>
      <textarea
        id="run-comment-textarea"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        maxLength={MAX_LEN}
        rows={4}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
        placeholder="Notes on this run…"
        data-testid="comment-textarea"
      />
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
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
        <span className="text-sm text-red-600" data-testid="comment-error">
          {error}
        </span>
      )}
    </div>
  );
}
