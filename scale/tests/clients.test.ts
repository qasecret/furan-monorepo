import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { Counter, Histogram, Registry } from "@furan/telemetry";
import { afterEach, describe, expect, it } from "vitest";

import { loginOnce, mintJwt, trpc, verifyAuth } from "../src/clients/http.js";
import { readCounter, readHistogram } from "../src/clients/metrics.js";

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  contentType: string | undefined;
  body: string;
}

let server: Server | undefined;

/** A server that records each request and answers with `reply`. */
async function serve(
  reply: (seen: Seen) => { status?: number; body: unknown },
): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const entry: Seen = {
        method: req.method ?? "",
        url: req.url ?? "",
        auth: req.headers.authorization,
        contentType: req.headers["content-type"],
        body: Buffer.concat(chunks).toString("utf8"),
      };
      seen.push(entry);
      const { status = 200, body } = reply(entry);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen };
}

afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r));
  server = undefined;
});

describe("trpc", () => {
  it("sends a query as one unbatched GET with the input in the URL", async () => {
    const { url, seen } = await serve(() => ({
      body: { result: { data: { rows: [1, 2, 3] } } },
    }));
    const input = { projectId: "a b&c", limit: 2 };
    const res = await trpc(url, "tok").query("builds.list", input);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("GET");
    expect(seen[0]?.url).toBe(
      `/trpc/builds.list?input=${encodeURIComponent(JSON.stringify(input))}`,
    );
    expect(seen[0]?.auth).toBe("Bearer tok");
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ rows: [1, 2, 3] });
    expect(res.ms).toBeGreaterThanOrEqual(0);
  });

  it("leaves the input out of a query that has none", async () => {
    const { url, seen } = await serve(() => ({
      body: { result: { data: 1 } },
    }));
    await trpc(url, "tok").query("builds.pendingCount");
    expect(seen[0]?.url).toBe("/trpc/builds.pendingCount");
  });

  it("sends a mutation as a POST with the raw input as the body", async () => {
    const { url, seen } = await serve(() => ({
      body: { result: { data: { ok: true } } },
    }));
    const res = await trpc(url, "tok").mutation("review.approve", { id: "x" });

    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.url).toBe("/trpc/review.approve");
    expect(seen[0]?.contentType).toBe("application/json");
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({ id: "x" });
    expect(res.data).toEqual({ ok: true });
  });

  it("reports bytes as the length of the decoded body", async () => {
    const payload = { result: { data: { text: "héllo" } } };
    const { url } = await serve(() => ({ body: payload }));
    const res = await trpc(url, "tok").query("x.y");
    expect(res.bytes).toBe(Buffer.byteLength(JSON.stringify(payload)));
  });

  it("hands back the status and the error of a failed call", async () => {
    const { url } = await serve(() => ({
      status: 403,
      body: { error: { message: "no", data: { code: "FORBIDDEN" } } },
    }));
    const res = await trpc(url, "tok").query("x.y");
    expect(res.status).toBe(403);
    expect(res.data).toBeUndefined();
    expect(res.error).toMatchObject({ message: "no" });
  });
});

describe("loginOnce and verifyAuth", () => {
  it("returns the token of a real login", async () => {
    const { url, seen } = await serve(() => ({
      body: { token: "jwt-1", user: { id: "u" } },
    }));
    expect(await loginOnce(url, "a@b.c", "pw")).toBe("jwt-1");
    expect(seen[0]?.url).toBe("/auth/login");
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({
      email: "a@b.c",
      password: "pw",
    });
  });

  it("fails a login the server refuses, without echoing the password", async () => {
    const { url } = await serve(() => ({
      status: 401,
      body: { error: "invalid_credentials" },
    }));
    const failure = await loginOnce(url, "a@b.c", "hunter2").catch(
      (e: unknown) => e as Error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("401");
    expect((failure as Error).message).not.toContain("hunter2");
  });

  it("passes when /users/me answers 200 for both tokens", async () => {
    const { url, seen } = await serve(() => ({ body: { id: "u" } }));
    await verifyAuth(url, { minted: "m", loggedIn: "l" });
    expect(seen.map((s) => [s.url, s.auth])).toEqual([
      ["/users/me", "Bearer m"],
      ["/users/me", "Bearer l"],
    ]);
  });

  it("fails when either token is refused, naming which", async () => {
    const { url } = await serve((seen) =>
      seen.auth === "Bearer m"
        ? { status: 401, body: {} }
        : { body: { id: "u" } },
    );
    await expect(
      verifyAuth(url, { minted: "m", loggedIn: "l" }),
    ).rejects.toThrow(/minted/);
  });
});

describe("mintJwt", () => {
  it("signs the claim routes/auth.ts signs", () => {
    const signed: unknown[] = [];
    const app = {
      jwt: {
        sign: (payload: unknown) => {
          signed.push(payload);
          return "signed";
        },
      },
    };
    expect(mintJwt(app, { id: "u1", role: "editor" })).toBe("signed");
    expect(signed).toEqual([{ sub: "u1", role: "editor" }]);
  });
});

describe("metrics readers", () => {
  it("reads a histogram's count and sum, filtered by labels", async () => {
    const registry = new Registry();
    const h = new Histogram({
      name: "t_seconds",
      help: "t",
      labelNames: ["procedure", "outcome"],
      buckets: [1, 5],
      registers: [registry],
    });
    h.observe({ procedure: "a", outcome: "ok" }, 2);
    h.observe({ procedure: "a", outcome: "ok" }, 3);
    h.observe({ procedure: "b", outcome: "ok" }, 10);

    expect(await readHistogram(registry, "t_seconds")).toEqual({
      count: 3,
      sum: 15,
    });
    expect(
      await readHistogram(registry, "t_seconds", { procedure: "a" }),
    ).toEqual({ count: 2, sum: 5 });
    expect(
      await readHistogram(registry, "t_seconds", { procedure: "zzz" }),
    ).toEqual({ count: 0, sum: 0 });
  });

  it("reads a counter, filtered by labels", async () => {
    const registry = new Registry();
    const c = new Counter({
      name: "t_total",
      help: "t",
      labelNames: ["kind"],
      registers: [registry],
    });
    c.inc({ kind: "x" }, 2);
    c.inc({ kind: "y" });
    expect(await readCounter(registry, "t_total")).toBe(3);
    expect(await readCounter(registry, "t_total", { kind: "x" })).toBe(2);
  });

  it("throws for a metric that is not registered, instead of reading 0", async () => {
    const registry = new Registry();
    await expect(readCounter(registry, "nope_total")).rejects.toThrow(
      /nope_total/,
    );
    await expect(readHistogram(registry, "nope_seconds")).rejects.toThrow(
      /nope_seconds/,
    );
  });
});
