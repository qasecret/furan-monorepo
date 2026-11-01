import { randomUUID } from "node:crypto";

import { FuranApiError } from "./errors.js";
import { VERSION } from "./version.js";

export interface TransportOptions {
  apiUrl: string;
  token: string;
  fetch?: typeof fetch;
  /** Retries after the first attempt (default 3). */
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Per-attempt timeout (default 30 s). */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const NOT_JSON_HINT =
  "response was not JSON; FURAN_API_URL must be the Furan api (e.g. http://host:8080/api), not the dashboard";

const sleepFor = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Statuses worth another try: the request may succeed if sent again. */
const retriable = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500;

/**
 * HTTP to the Furan api: bearer auth, a request id, JSON in and out, and
 * jittered exponential retries on network errors, 408, 429 and 5xx. Every
 * failure is a {@link FuranApiError}; the token never appears in one.
 */
export class Transport {
  private readonly apiUrl: string;
  private readonly fetch: typeof fetch;
  private readonly retries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly headers: Record<string, string>;

  constructor(opts: TransportOptions) {
    // Joined as strings (never `new URL(path, base)`), so a path prefix such
    // as the one-file deploy's `/api` is kept.
    this.apiUrl = opts.apiUrl.replace(/\/+$/, "");
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.retries = opts.retries ?? 3;
    this.baseDelayMs = opts.baseDelayMs ?? 500;
    this.maxDelayMs = opts.maxDelayMs ?? 8_000;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.sleep = opts.sleep ?? sleepFor;
    this.random = opts.random ?? Math.random;
    this.headers = {
      authorization: `Bearer ${opts.token}`,
      "user-agent": `furan-js/${VERSION} (node/${process.version})`,
    };
  }

  async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const requestId = randomUUID();
    const url = `${this.apiUrl}/${path}`;
    const headers: Record<string, string> = {
      ...this.headers,
      "x-request-id": requestId,
    };
    let payload: RequestInit["body"] | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }

    for (let attempt = 0; ; attempt++) {
      const last = attempt >= this.retries;
      let res: Response;
      try {
        res = await this.fetch(url, {
          method,
          headers,
          ...(payload !== undefined ? { body: payload } : {}),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (cause) {
        if (last) {
          throw new FuranApiError(
            {
              status: 0,
              code: "network_error",
              message: `could not reach ${this.apiUrl}: ${describe(cause)}`,
              method,
              path,
              requestId,
            },
            { cause },
          );
        }
        await this.sleep(this.backoff(attempt, null));
        continue;
      }

      if (retriable(res.status) && !last) {
        await res.body?.cancel();
        await this.sleep(this.backoff(attempt, res.headers.get("retry-after")));
        continue;
      }
      return this.read<T>(res, method, path, requestId);
    }
  }

  private backoff(attempt: number, retryAfter: string | null): number {
    if (retryAfter !== null && /^\d+$/.test(retryAfter.trim())) {
      return Math.min(this.maxDelayMs, Number(retryAfter) * 1000);
    }
    return (
      this.random() * Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** attempt)
    );
  }

  private async read<T>(
    res: Response,
    method: string,
    path: string,
    requestId: string,
  ): Promise<T> {
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new FuranApiError({
          status: res.status,
          code: "invalid_response",
          message: NOT_JSON_HINT,
          method,
          path,
          requestId,
        });
      }
    }
    if (res.ok) return parsed as T;

    const envelope =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { code?: unknown; message?: unknown; details?: unknown })
        : {};
    throw new FuranApiError({
      status: res.status,
      code:
        typeof envelope.code === "string"
          ? envelope.code
          : `http_${res.status}`,
      message:
        typeof envelope.message === "string"
          ? envelope.message
          : res.statusText || "request failed",
      method,
      path,
      requestId,
      ...(envelope.details !== undefined ? { details: envelope.details } : {}),
    });
  }
}

function describe(cause: unknown): string {
  if (cause instanceof Error) {
    const inner = (cause as { cause?: unknown }).cause;
    return inner instanceof Error
      ? `${cause.message} (${inner.message})`
      : cause.message;
  }
  return String(cause);
}
