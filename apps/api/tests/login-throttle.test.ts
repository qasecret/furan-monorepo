import { randomUUID } from "node:crypto";
import { createServer } from "node:net";

import { eq, users } from "@furan/db";
import { createFailFastRedisConnection, type Redis } from "@furan/queue";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { hashPassword } from "../src/lib/password.js";
import { createRateLimitRedis } from "../src/lib/rate-limit-redis.js";

import { createTestApp, type TestApp } from "./helpers.js";

// ADR-063 login throttling. Per-IP: 10 / 1 min keyed by req.ip (which honours
// TRUST_PROXY). Per-account: 10 / 15 min keyed by sha256(trimmed lowercased
// email), across all client IPs. Every test uses its own client IPs and
// emails so buckets never leak between tests (the in-memory store lives per
// app instance; the Redis tests use a per-run namespace and clean it up).

const PASSWORD = "correct-horse-battery-staple"; // gitleaks:allow

function uniqueEmail(tag: string): string {
  return `rl-${tag}-${randomUUID().slice(0, 8)}@throttle.example`;
}

// Unique per call so separate tests never share a per-IP bucket.
let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `198.51.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

interface LoginOpts {
  email: unknown;
  password?: string;
  /** Socket peer (light-my-request `remoteAddress`). */
  remoteAddress?: string;
  xff?: string;
}

function login(h: TestApp, o: LoginOpts): Promise<LightMyRequestResponse> {
  return h.app.inject({
    method: "POST",
    url: "/auth/login",
    remoteAddress: o.remoteAddress ?? "127.0.0.1",
    headers: o.xff !== undefined ? { "x-forwarded-for": o.xff } : {},
    payload: { email: o.email, password: o.password ?? "wrong-password" },
  });
}

function expectRateLimited(res: LightMyRequestResponse): void {
  expect(res.statusCode).toBe(429);
  expect(res.json()).toMatchObject({ code: "rate_limited", statusCode: 429 });
  const retryAfter = Number(res.headers["retry-after"]);
  expect(retryAfter).toBeGreaterThan(0);
}

async function seedUser(h: TestApp, email: string): Promise<void> {
  await h.db.insert(users).values({
    email,
    hashedPassword: await hashPassword(PASSWORD),
    firstName: "Rate",
    lastName: "Limit",
    role: "editor",
    isActive: true,
  });
}

describe("POST /auth/login — per-IP limit, TRUST_PROXY unset (default)", () => {
  let h: TestApp;
  beforeAll(async () => {
    h = await createTestApp({ envOverrides: { TRUST_PROXY: undefined } });
  });
  afterAll(async () => {
    await h.close();
  });

  test("spoofed X-Forwarded-For does NOT mint fresh buckets: same socket peer → 11th is 429", async () => {
    const peer = nextIp();
    for (let i = 0; i < 10; i++) {
      const res = await login(h, {
        email: uniqueEmail("spoof"),
        remoteAddress: peer,
        xff: `203.0.113.${i + 1}`,
      });
      expect(res.statusCode).toBe(401);
    }
    const res = await login(h, {
      email: uniqueEmail("spoof"),
      remoteAddress: peer,
      xff: "203.0.113.99",
    });
    expectRateLimited(res);
    expect(res.headers["retry-after"]).toBeDefined();
  });

  test("a different socket peer has its own bucket", async () => {
    const res = await login(h, {
      email: uniqueEmail("other-peer"),
      remoteAddress: nextIp(),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /auth/login — TRUST_PROXY=1 (one trusted proxy hop)", () => {
  let h: TestApp;
  const proxy = "10.0.0.2";
  beforeAll(async () => {
    h = await createTestApp({ envOverrides: { TRUST_PROXY: "1" } });
  });
  afterAll(async () => {
    await h.close();
  });

  test("per-IP buckets are keyed by the forwarded client IP, not the proxy", async () => {
    const clientA = nextIp();
    const clientB = nextIp();
    for (let i = 0; i < 10; i++) {
      const res = await login(h, {
        email: uniqueEmail("client-a"),
        remoteAddress: proxy,
        xff: clientA,
      });
      expect(res.statusCode).toBe(401);
    }
    expectRateLimited(
      await login(h, {
        email: uniqueEmail("client-a"),
        remoteAddress: proxy,
        xff: clientA,
      }),
    );
    // Same proxy socket, different forwarded client → its own bucket.
    const resB = await login(h, {
      email: uniqueEmail("client-b"),
      remoteAddress: proxy,
      xff: clientB,
    });
    expect(resB.statusCode).toBe(401);
  });

  test("per-account: 11 attempts on one email from 11 different IPs → 11th is 429; another email unaffected", async () => {
    const victim = uniqueEmail("victim");
    // Case + surrounding-whitespace variants all land in the same bucket.
    const variants = [victim, victim.toUpperCase(), `  ${victim} `];
    for (let i = 0; i < 10; i++) {
      const res = await login(h, {
        email: variants[i % variants.length],
        remoteAddress: proxy,
        xff: nextIp(),
      });
      // Whitespace-padded variants fail the handler's body schema (400);
      // they still count against the account (key normalizes first).
      expect([400, 401]).toContain(res.statusCode);
    }
    expectRateLimited(
      await login(h, { email: victim, remoteAddress: proxy, xff: nextIp() }),
    );
    // A different account is untouched.
    const other = await login(h, {
      email: uniqueEmail("bystander"),
      remoteAddress: proxy,
      xff: nextIp(),
    });
    expect(other.statusCode).toBe(401);
  });

  test("per-account limit also gates the correct password (no oracle once the bucket is spent)", async () => {
    const email = uniqueEmail("real");
    await seedUser(h, email);
    try {
      for (let i = 0; i < 10; i++) {
        const res = await login(h, {
          email,
          remoteAddress: proxy,
          xff: nextIp(),
        });
        expect(res.statusCode).toBe(401);
      }
      expectRateLimited(
        await login(h, {
          email,
          password: PASSWORD,
          remoteAddress: proxy,
          xff: nextIp(),
        }),
      );
    } finally {
      await h.db.delete(users).where(eq(users.email, email));
    }
  });

  test("bodies without a valid email skip the per-account check (handler 400s)", async () => {
    for (let i = 0; i < 12; i++) {
      const res = await login(h, {
        email: "not-an-email",
        remoteAddress: proxy,
        xff: nextIp(),
      });
      expect(res.statusCode).toBe(400);
    }
  });
});

const skipRedis = !process.env.REDIS_URL;

async function waitReady(redis: Redis): Promise<void> {
  if (redis.status === "ready") return;
  await new Promise<void>((resolve, reject) => {
    redis.once("ready", () => resolve());
    redis.once("end", () => reject(new Error("redis connection ended")));
  });
}

describe.skipIf(skipRedis)(
  "POST /auth/login — shared Redis store (cross-replica)",
  () => {
    const nameSpace = `furan:rl:test-${randomUUID()}:`;
    let redisA: Redis;
    let redisB: Redis;
    let a: TestApp;
    let b: TestApp;
    beforeAll(async () => {
      // Two "replicas", each with its own connection to the same Redis.
      redisA = createFailFastRedisConnection(process.env.REDIS_URL);
      redisB = createFailFastRedisConnection(process.env.REDIS_URL);
      await Promise.all([waitReady(redisA), waitReady(redisB)]);
      const envOverrides = { TRUST_PROXY: undefined };
      a = await createTestApp({
        envOverrides,
        rateLimitStore: { redis: redisA, nameSpace },
      });
      b = await createTestApp({
        envOverrides,
        rateLimitStore: { redis: redisB, nameSpace },
      });
    });
    afterAll(async () => {
      await a?.close();
      await b?.close();
      // Delete only this run's keys.
      let cursor = "0";
      do {
        const [next, keys] = await redisA.scan(
          cursor,
          "MATCH",
          `${nameSpace}*`,
          "COUNT",
          100,
        );
        cursor = next;
        if (keys.length > 0) await redisA.del(...keys);
      } while (cursor !== "0");
      await redisA.quit();
      await redisB.quit();
    });

    test("per-IP counters are shared: 5 on replica A + 5 on B → 11th (on A) is 429", async () => {
      const peer = nextIp();
      for (let i = 0; i < 10; i++) {
        const res = await login(i % 2 === 0 ? a : b, {
          email: uniqueEmail("xr-ip"),
          remoteAddress: peer,
        });
        expect(res.statusCode).toBe(401);
      }
      expectRateLimited(
        await login(a, { email: uniqueEmail("xr-ip"), remoteAddress: peer }),
      );
    });

    test("per-account counters are shared across replicas and client IPs", async () => {
      const email = uniqueEmail("xr-acct");
      for (let i = 0; i < 10; i++) {
        const res = await login(i % 2 === 0 ? a : b, {
          email,
          remoteAddress: nextIp(),
        });
        expect(res.statusCode).toBe(401);
      }
      expectRateLimited(await login(b, { email, remoteAddress: nextIp() }));
      // No raw email in any key; the account bucket is the sha256 digest.
      const keys = await redisA.keys(`${nameSpace}*`);
      expect(keys.length).toBeGreaterThan(0);
      for (const k of keys) expect(k).not.toContain("@");
      expect(keys.some((k) => /login-account:[0-9a-f]{64}$/.test(k))).toBe(
        true,
      );
    });
  },
);

describe("POST /auth/login — Redis store unreachable (fail open)", () => {
  let h: TestApp;
  let redis: Redis;
  const logger = { warn: vi.fn(), info: vi.fn() };
  const email = uniqueEmail("failopen");
  beforeAll(async () => {
    // A port nothing listens on: bind an ephemeral port, then release it.
    const port = await new Promise<number>((resolve) => {
      const srv = createServer();
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        const p = typeof addr === "object" && addr ? addr.port : 0;
        srv.close(() => resolve(p));
      });
    });
    // Same factory + options as server.ts.
    redis = createRateLimitRedis(logger, `redis://127.0.0.1:${port}`);
    h = await createTestApp({
      envOverrides: { TRUST_PROXY: undefined },
      rateLimitStore: { redis, nameSpace: `furan:rl:test-${randomUUID()}:` },
    });
    await seedUser(h, email);
  });
  afterAll(async () => {
    await h.db.delete(users).where(eq(users.email, email));
    await h.close();
    redis.disconnect();
  });

  test("logins still answer 401/200 promptly — never 500, never a hang, never 429", async () => {
    const peer = nextIp();
    const started = Date.now();
    // 12 > the per-IP max: with the store down the limiter is skipped.
    for (let i = 0; i < 12; i++) {
      const res = await login(h, { email, remoteAddress: peer });
      expect(res.statusCode).toBe(401);
    }
    const ok = await login(h, {
      email,
      password: PASSWORD,
      remoteAddress: peer,
    });
    expect(ok.statusCode).toBe(200);
    expect(Date.now() - started).toBeLessThan(5_000);
    // The outage is surfaced once, not per request.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.anything(),
      "rate_limit_store_unavailable_failing_open",
    );
  }, 15_000);
});
