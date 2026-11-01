/** Base class of every error this package throws. */
export class FuranError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** A required setting is missing or invalid. `variable` names its env var. */
export class FuranConfigError extends FuranError {
  constructor(
    readonly variable: string,
    message: string,
  ) {
    super(message);
  }
}

/** A screenshot, region or other input is unusable; nothing was sent. */
export class FuranInputError extends FuranError {
  readonly file?: string;

  constructor(message: string, file?: string) {
    super(file === undefined ? message : `${file}: ${message}`);
    if (file !== undefined) this.file = file;
  }
}

export interface ApiErrorInit {
  status: number;
  code: string;
  message: string;
  method: string;
  path: string;
  requestId: string;
  details?: unknown;
}

/** The api answered with an error (after any retries). */
export class FuranApiError extends FuranError {
  readonly status: number;
  readonly code: string;
  readonly method: string;
  readonly path: string;
  readonly requestId: string;
  readonly details?: unknown;

  constructor(init: ApiErrorInit, options?: { cause?: unknown }) {
    super(
      `${init.method} /${init.path} → ${init.status} ${init.code}: ${init.message}`,
      options,
    );
    this.status = init.status;
    this.code = init.code;
    this.method = init.method;
    this.path = init.path;
    this.requestId = init.requestId;
    if (init.details !== undefined) this.details = init.details;
  }
}

/** A run had no verdict before the deadline. */
export class FuranTimeoutError extends FuranError {
  constructor(
    readonly runId: string,
    readonly lastStatus: string | null,
    timeoutMs: number,
  ) {
    super(
      `run ${runId} had no verdict within ${Math.round(timeoutMs / 1000)}s (last status: ${lastStatus ?? "unknown"})`,
    );
  }
}
