"use client";

import { create } from "zustand";

import { announce } from "@/lib/review/review-announcer";

/**
 * The single-key switch (WCAG 2.1.4, spec §3.5): whether letter and symbol
 * keys ("a", "j", "?", "g i") trigger commands. On by default, kept per
 * browser; ⌘K, ⌘Z, arrows, Enter and Esc are unaffected by it.
 */

export const SINGLE_KEYS_STORAGE_KEY = "furan:keys:single";

/** Stored as "1" / "0" like the other per-browser switches. Default: on. */
function readStored(): boolean {
  try {
    return window.localStorage.getItem(SINGLE_KEYS_STORAGE_KEY) !== "0";
  } catch {
    // Blocked storage (privacy modes): the default.
    return true;
  }
}

function writeStored(on: boolean): void {
  try {
    window.localStorage.setItem(SINGLE_KEYS_STORAGE_KEY, on ? "1" : "0");
  } catch {
    // Not persisted; the switch still holds for this page.
  }
}

/**
 * The store is created `on`, and the stored choice is applied straight after.
 * Zustand's server snapshot is the state it was created with, so the server
 * and the client's hydrating render both say "on" and match; the client then
 * re-renders with the stored choice, like `usePlatform`.
 */
export const useSingleKeyStore = create<{ on: boolean }>(() => ({ on: true }));

if (typeof window !== "undefined" && !readStored()) {
  useSingleKeyStore.setState({ on: false });
}

// Another tab's change: follow it. That tab announced it, so this one does
// not; `newValue` is null when its storage was cleared (the default, on).
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== SINGLE_KEYS_STORAGE_KEY && e.key !== null) return;
    useSingleKeyStore.setState({ on: e.newValue !== "0" });
  });
}

/**
 * Turns the single-key shortcuts on or off: stores the choice and announces
 * it ("Single-key shortcuts off" / "Single-key shortcuts on"). No hook, so a
 * command's `run` can call it.
 */
export function setSingleKeys(on: boolean): void {
  writeStored(on);
  useSingleKeyStore.setState({ on });
  announce(on ? "Single-key shortcuts on" : "Single-key shortcuts off");
}

/** A plain read, for the dispatcher at key-press time. */
export function singleKeysOn(): boolean {
  return useSingleKeyStore.getState().on;
}

/** The switch for rendering: `[on, set]`. */
export function useSingleKeyShortcuts(): [
  on: boolean,
  set: (on: boolean) => void,
] {
  const on = useSingleKeyStore((s) => s.on);
  return [on, setSingleKeys];
}
