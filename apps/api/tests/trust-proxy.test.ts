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

  test.each([
    ["0", 0],
    ["1", 1],
    [" 2 ", 2],
    ["10", 10],
  ])("%j → hop count %d", (raw, hops) => {
    expect(parseTrustProxy(raw)).toBe(hops);
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

  test.each([
    "false",
    "true",
    "1",
    "loopback,10.0.0.0/8,fd00::/8,192.168.1.10,::1",
  ])("Fastify accepts the parsed form of %j", async (raw) => {
    const app = Fastify({ trustProxy: parseTrustProxy(raw) });
    await app.ready();
    await app.close();
  });
});

describe("envSchema TRUST_PROXY", () => {
  test("unset is valid", () => {
    expect(envSchema.safeParse({ ...VALID_BASE }).success).toBe(true);
  });

  test.each(["1", "true", "false", "10.0.0.0/8,loopback"])(
    "accepts %j",
    (TRUST_PROXY) => {
      expect(envSchema.safeParse({ ...VALID_BASE, TRUST_PROXY }).success).toBe(
        true,
      );
    },
  );

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
