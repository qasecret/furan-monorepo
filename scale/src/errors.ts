/**
 * Error text for the console and the report. A driver's message can quote the
 * connection string it was given (`postgres://user:password@host/db`), so the
 * credentials are cut out before the text goes anywhere.
 */
const CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi;

export function redact(text: string): string {
  return text.replace(CREDENTIALS, "$1***@");
}

/** The message of anything that was thrown, redacted. */
export function describeError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "unknown error";
  return redact(message === "" ? "unknown error" : message);
}

/** Thrown inside the main flow once a signal has started the teardown. */
export class InterruptedError extends Error {
  constructor() {
    super("interrupted");
    this.name = "InterruptedError";
  }
}
