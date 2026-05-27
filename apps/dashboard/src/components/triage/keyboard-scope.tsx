"use client";

import { useEffect, type ReactNode } from "react";

interface Props {
  bindings: Record<string, () => void>;
  children: ReactNode;
}

const ALWAYS_FIRE = new Set(["Escape", "Tab"]);

export function KeyboardScope({ bindings, children }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const inField = target.matches?.(
        "input, textarea, [contenteditable=true]",
      );
      if (inField && !ALWAYS_FIRE.has(e.key)) return;
      const handler = bindings[e.key];
      if (handler) {
        e.preventDefault();
        handler();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [bindings]);

  return <>{children}</>;
}
