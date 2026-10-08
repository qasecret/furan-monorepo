import Fastify from "fastify";
import { describe, expect, test } from "vitest";

import { envSchema } from "../src/env.js";
import { parseTrustProxy } from "../src/lib/trust-proxy.js";

const VALID_BASE = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://furan:devpw@localhost:5433/furan_dev",
  JWT_SECRET: "x".repeat(32),
};

describe("parseTrustProxy (TRUST_PROXY → Fastify trustProxy)", () => {
  test.each([undefined, "", "   ", "false", "FALSE", " false "])(
    "%j → false (default: X-Forwarded-For ignored)",
    (raw) => {
      expect(parseTrustProxy(raw)).toBe(false);
    },
  );

  test.each(["true", "TRUE", " true "])(
    "%j → true (trust every hop)",
    (raw) => {
      expect(parseTrustProxy(raw)).toBe(true);
    },
  );

  // Fastify >= 5.12 ignores a numeric (hop-count) trustProxy — it fails
  // closed because a hop count can't tell the real proxy from a direct client
  // that sends enough X-Forwarded-For entries. Reject it at boot instead of
  // letting it silently disable per-IP rate limiting (ADR-065).
  test.each(["0", "1", " 2 ", "10"])(
    "%j (a hop count) is rejected — name the proxy's address instead",
    (raw) => {
      expect(() => parseTrustProxy(raw)).toThrow(/hop count/);
    },
  );

  // Behind a proxy, trust it by ADDRESS: X-Forwarded-For is honoured only
  // when the immediate peer is that proxy, so the right-most untrusted entry
  // (what the proxy itself appended) becomes req.ip.
  test("an address-based setting yields the client IP the proxy appended", async () => {
    const app = Fastify({ trustProxy: parseTrustProxy("172.20.0.4") });
    app.get("/ip", async (req) => ({ ip: req.ip }));
    // nginx (peer 172.20.0.4) appended the real client to a forged entry.
    const res = await app.inject({
      method: "GET",
      url: "/ip",
      remoteAddress: "172.20.0.4",
      headers: { "x-forwarded-for": "6.6.6.6, 172.20.0.5" },
    });
    expect(res.json()).toEqual({ ip: "172.20.0.5" });
    await app.close();
  });

  test("a direct client that isn't the trusted proxy can't spoof its IP", async () => {
    const app = Fastify({ trustProxy: parseTrustProxy("172.20.0.4") });
    app.get("/ip", async (req) => ({ ip: req.ip }));
    const res = await app.inject({
      method: "GET",
      url: "/ip",
      remoteAddress: "203.0.113.9",
      headers: { "x-forwarded-for": "6.6.6.6" },
    });
    expect(res.json()).toEqual({ ip: "203.0.113.9" });
    await app.close();
  });

  // `uniquelocal` trusts every private address — including a client on a
  // private LAN. It's only safe when the edge proxy REPLACES X-Forwarded-For
  // with the client's address (nginx `proxy_set_header X-Forwarded-For
  // $remote_addr`), so the api sees exactly [proxy peer, real client].
  test.each([
    ["a LAN client", "192.168.1.50"],
    ["a public client", "203.0.113.7"],
  ])(
    "uniquelocal + an edge that overwrites XFF yields %s's real IP",
    async (_label, client) => {
      const app = Fastify({ trustProxy: parseTrustProxy("uniquelocal") });
      app.get("/ip", async (req) => ({ ip: req.ip }));
      const res = await app.inject({
        method: "GET",
        url: "/ip",
        remoteAddress: "172.20.0.4",
        headers: { "x-forwarded-for": client },
      });
      expect(res.json()).toEqual({ ip: client });
      await app.close();
    },
  );

  test("trusting the exact proxy address resists a LAN client's forged XFF even if the proxy appends", async () => {
    const app = Fastify({ trustProxy: parseTrustProxy("172.20.0.4") });
    app.get("/ip", async (req) => ({ ip: req.ip }));
    const res = await app.inject({
      method: "GET",
      url: "/ip",
      remoteAddress: "172.20.0.4",
      headers: { "x-forwarded-for": "6.6.6.6, 192.168.1.50" },
    });
    expect(res.json()).toEqual({ ip: "192.168.1.50" });
    await app.close();
  });

  test("IPs, CIDRs and proxy-addr keywords pass through as a trimmed list", () => {
    expect(
      parseTrustProxy(
        "10.0.0.1, 172.16.0.0/12 ,::1,fd00::/8,LoopBack,linklocal,uniquelocal,0.0.0.0/0",
      ),
    ).toEqual([
      "10.0.0.1",
      "172.16.0.0/12",
      "::1",
      "fd00::/8",
      "loopback",
      "linklocal",
      "uniquelocal",
      "0.0.0.0/0",
    ]);
  });

  test("a single IP is a one-entry list", () => {
    expect(parseTrustProxy("192.168.1.10")).toEqual(["192.168.1.10"]);
  });

  test.each([
    "yes",
    "1.5",
    "-1",
    "10.0.0.256",
    "10.0.0.0/33",
    "10.0.0.0/-1",
    "10.0.0.0/",
    "10.0.0.0/8/8",
    "10.0.0.0/255.0.0.0",
    "::1/129",
    "example.com",
    "10.0.0.1,,10.0.0.2",
    "10.0.0.1,",
    "loopback,garbage",
    "99999999999999999999",
  ])("%j → throws (fail closed)", (raw) => {
    expect(() => parseTrustProxy(raw)).toThrow(/TRUST_PROXY/);
  });

  test("error message names the bad entry's position, never echoes the value", () => {
    expect(() => parseTrustProxy("10.0.0.1,not-a-proxy")).toThrow(/entry 2/);
    try {
      parseTrustProxy("10.0.0.1,not-a-proxy");
    } catch (err) {
      expect((err as Error).message).not.toContain("not-a-proxy");
    }
  });

  test.each(["false", "true", "loopback,10.0.0.0/8,fd00::/8,192.168.1.10,::1"])(
    "Fastify accepts the parsed form of %j",
    async (raw) => {
      const app = Fastify({ trustProxy: parseTrustProxy(raw) });
      await app.ready();
      await app.close();
    },
  );
});

describe("envSchema TRUST_PROXY", () => {
  test("unset is valid", () => {
    expect(envSchema.safeParse({ ...VALID_BASE }).success).toBe(true);
  });

  test.each(["true", "false", "10.0.0.0/8,loopback", "uniquelocal"])(
    "accepts %j",
    (TRUST_PROXY) => {
      expect(envSchema.safeParse({ ...VALID_BASE, TRUST_PROXY }).success).toBe(
        true,
      );
    },
  );

  test("refuses a hop count at boot", () => {
    const result = envSchema.safeParse({ ...VALID_BASE, TRUST_PROXY: "1" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/hop count/);
    }
  });

  test("refuses garbage at boot (fail closed)", () => {
    const result = envSchema.safeParse({
      ...VALID_BASE,
      TRUST_PROXY: "10.0.0.1,nonsense",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.flatten().fieldErrors)).toMatch(
        /TRUST_PROXY/,
      );
    }
  });
});
