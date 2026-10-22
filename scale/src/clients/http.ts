import type { UserRole } from "@furan/shared-types";

/** The signer `@fastify/jwt` adds to the api's Fastify instance. */
interface JwtSigner {
  jwt: { sign(payload: { sub: string; role: UserRole }): string };
}

/** The HTTP failure of a call the harness could not continue after. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * The real `POST /auth/login`. The harness does it once, for the one seeded
 * user that has a password; every other user is minted a token (`mintJwt`).
 * An error names the status only: a body or the request could carry the
 * password.
 */
export async function loginOnce(
  apiUrl: string,
  email: string,
  password: string,
): Promise<string> {
  const res = await fetch(`${apiUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) {
    throw new HttpError(res.status, `POST /auth/login answered ${res.status}`);
  }
  const body = (await res.json()) as { token?: unknown };
  if (typeof body.token !== "string" || body.token === "") {
    throw new HttpError(res.status, "POST /auth/login returned no token");
  }
  return body.token;
}

/**
 * A token for `user`, signed with the claim `routes/auth.ts` signs at login:
 * what a reviewer's session would carry, without a password round trip (and
 * without bcrypt per simulated reviewer).
 */
export function mintJwt(
  // Typed as `object`: the `jwt` property comes from a module augmentation in
  // the api's own build, which this package does not load.
  app: object,
  user: { id: string; role: UserRole },
): string {
  const signer = (app as Partial<JwtSigner>).jwt;
  if (typeof signer?.sign !== "function") {
    throw new Error("the api has no JWT signer");
  }
  return signer.sign({ sub: user.id, role: user.role });
}

/**
 * The startup check: `GET /users/me` must answer 200 for a minted token and
 * for the logged-in one, so a suite never measures a wall of 401s.
 */
export async function verifyAuth(
  apiUrl: string,
  tokens: { minted: string; loggedIn: string },
): Promise<void> {
  for (const [label, token] of [
    ["minted", tokens.minted],
    ["logged-in", tokens.loggedIn],
  ] as const) {
    const res = await fetch(`${apiUrl}/users/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    await res.arrayBuffer();
    if (res.status !== 200) {
      throw new HttpError(
        res.status,
        `GET /users/me with the ${label} token answered ${res.status}`,
      );
    }
  }
}

export interface TrpcResult {
  /** Client wall time: request sent to body read. */
  ms: number;
  /** Length of the decoded response body. */
  bytes: number;
  status: number;
  /** `result.data` of a successful call. */
  data: unknown;
  /** The `error` of a failed one. */
  error?: unknown;
}

async function send(
  apiUrl: string,
  token: string,
  path: string,
  init: { method: "GET" | "POST"; query?: string; body?: unknown },
): Promise<TrpcResult> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const started = performance.now();
  const res = await fetch(`${apiUrl}/trpc/${path}${init.query ?? ""}`, {
    method: init.method,
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const buffer = Buffer.from(await res.arrayBuffer());
  const ms = performance.now() - started;

  let parsed: { result?: { data?: unknown }; error?: unknown } = {};
  try {
    parsed = JSON.parse(buffer.toString("utf8")) as typeof parsed;
  } catch {
    // Not JSON (a proxy error page, say): the status says what happened.
  }
  return {
    ms,
    bytes: buffer.byteLength,
    status: res.status,
    data: parsed.result?.data,
    ...(parsed.error !== undefined ? { error: parsed.error } : {}),
  };
}

/**
 * One unbatched tRPC call per procedure, so a measured time belongs to exactly
 * one procedure. This repo's tRPC has no transformer: a query carries its input
 * as JSON in the URL, a mutation as the raw JSON body.
 */
export function trpc(apiUrl: string, token: string) {
  return {
    query(path: string, input?: unknown): Promise<TrpcResult> {
      return send(apiUrl, token, path, {
        method: "GET",
        ...(input !== undefined
          ? { query: `?input=${encodeURIComponent(JSON.stringify(input))}` }
          : {}),
      });
    },
    mutation(path: string, input?: unknown): Promise<TrpcResult> {
      return send(apiUrl, token, path, {
        method: "POST",
        ...(input !== undefined ? { body: input } : {}),
      });
    },
  };
}
