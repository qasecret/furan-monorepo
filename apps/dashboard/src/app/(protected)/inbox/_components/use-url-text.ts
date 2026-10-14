"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A text field whose committed value lives in the URL (spec §3.3).
 *
 * The field is typed into at full speed and written to the URL after a pause
 * (or at once on `flush`: Enter, blur), because every write is a navigation.
 * The URL's value is followed when it changes from somewhere else (Back,
 * Forward, a link, `reset`), but never while it is merely catching up with what
 * this field wrote: otherwise a slow round trip would overwrite what the
 * reviewer typed in the meantime.
 *
 * The value is trimmed and an empty one is `undefined`, which clears it.
 */
export function useUrlText(
  urlValue: string | undefined,
  commit: (value: string | undefined) => void,
  delayMs = 300,
) {
  const [text, setText] = useState(urlValue ?? "");
  // What the URL holds, or will hold once our last write lands.
  const committed = useRef(urlValue);
  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  }, [commit]);

  useEffect(() => {
    if (urlValue !== committed.current) {
      committed.current = urlValue;
      setText(urlValue ?? "");
    }
  }, [urlValue]);

  const flushText = useCallback((value: string) => {
    const trimmed = value.trim();
    const next = trimmed === "" ? undefined : trimmed;
    if (next === committed.current) return;
    committed.current = next;
    commitRef.current(next);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => flushText(text), delayMs);
    return () => clearTimeout(timer);
  }, [text, delayMs, flushText]);

  /** Empty the field without writing: the caller writes the URL itself. */
  const reset = useCallback(() => {
    committed.current = undefined;
    setText("");
  }, []);

  return { text, setText, flush: () => flushText(text), reset };
}
