"use client";

import { toast } from "sonner";

import { lowerFirst } from "./keys";
import type { ResolvedCommand } from "./registry";
import type { Command, CommandCtx, RunMeta } from "./types";

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function failed(command: Command): void {
  // The id only: an error's message or stack may carry data.
  console.warn("command failed", command.id);
  toast.error(`Couldn't ${lowerFirst(command.label)}`);
}

/**
 * Runs a registered command the way every surface does (the key dispatcher,
 * the palette): with its live ctx, only while `enabled` holds, calling
 * `before` (the dispatcher's `preventDefault`) just before `run`, and telling
 * `run` how it ran (`meta`: the key that matched; `{}` from the palette). A
 * command that throws or rejects (any thenable), or whose `enabled` throws,
 * is reported with `Couldn't ‹label›` and never rethrown, so the next key
 * press or palette choice works as before. Returns whether it ran.
 */
export function runCommand(
  resolved: ResolvedCommand,
  before?: () => void,
  meta: RunMeta = {},
): boolean {
  const { command } = resolved;
  let ctx: CommandCtx;
  try {
    ctx = resolved.ctx();
    if (command.enabled && !command.enabled(ctx)) return false;
  } catch {
    failed(command);
    return false;
  }
  before?.();
  try {
    const result: unknown = command.run(ctx, meta);
    if (isThenable(result)) {
      void Promise.resolve(result).catch(() => failed(command));
    }
  } catch {
    failed(command);
  }
  return true;
}
