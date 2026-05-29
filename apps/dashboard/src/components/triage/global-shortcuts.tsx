"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { ShortcutsDialog } from "./shortcuts-dialog";

const SEQUENCE_WINDOW_MS = 1000;

// Two-key sequence prefix → handler. Keep this in sync with the rows
// listed by ShortcutsDialog; that dialog advertises these keys and
// users will try them, so adding a row there without a binding here
// makes the dialog a lie.
type SequenceMap = Record<string, Record<string, () => void>>;

/**
 * Mounted once at the protected-layout level. Handles the global
 * triage shortcuts the ShortcutsDialog advertises:
 *   - `?`     open the shortcuts dialog from anywhere
 *   - `g i`   go to /inbox
 *   - `g p`   go to /projects
 *
 * Per-page handlers (inbox row navigation, `/` filter focus, …)
 * remain on their own pages — this only owns the cross-page bindings.
 */
export function GlobalShortcuts() {
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const router = useRouter();
  const pendingPrefix = useRef<string | null>(null);
  const prefixTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const sequences: SequenceMap = {
      g: {
        i: () => router.push("/inbox"),
        p: () => router.push("/projects"),
      },
    };

    function clearPrefix() {
      pendingPrefix.current = null;
      if (prefixTimer.current) {
        clearTimeout(prefixTimer.current);
        prefixTimer.current = null;
      }
    }

    function onKey(e: KeyboardEvent) {
      // Modifier keys reserved for browser / OS shortcuts (Cmd+K, etc.)
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const target = e.target as HTMLElement | null;
      const inField = target?.matches?.(
        "input, textarea, [contenteditable=true]",
      );
      if (inField) return;

      // ? for help — Shift+/ on US layouts. e.key already resolves to
      // "?", so we don't need to inspect Shift directly.
      if (e.key === "?") {
        e.preventDefault();
        setShortcutsOpen(true);
        clearPrefix();
        return;
      }

      // Two-key sequence: first press records the prefix; second press
      // within the window fires the handler.
      const prefix = pendingPrefix.current;
      if (prefix) {
        const handler = sequences[prefix]?.[e.key];
        clearPrefix();
        if (handler) {
          e.preventDefault();
          handler();
        }
        return;
      }
      if (sequences[e.key]) {
        e.preventDefault();
        pendingPrefix.current = e.key;
        prefixTimer.current = setTimeout(clearPrefix, SEQUENCE_WINDOW_MS);
      }
    }

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      clearPrefix();
    };
  }, [router]);

  return (
    <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
  );
}
