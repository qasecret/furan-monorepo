import { describe, expect, it } from "vitest";

import { FORBIDDEN_PORTS, pickPort } from "../src/ports.js";

describe("pickPort", () => {
  it("never returns a forbidden port", async () => {
    const offered = [3000, 41234];
    const listen = async () => {
      const port = offered.shift();
      if (port === undefined) throw new Error("listener called too often");
      return port;
    };
    await expect(pickPort(listen)).resolves.toBe(41234);
    expect(offered).toEqual([]);
  });

  it("skips every forbidden port", async () => {
    const offered = [...FORBIDDEN_PORTS, 50000];
    const listen = async () => offered.shift() as number;
    await expect(pickPort(listen)).resolves.toBe(50000);
  });

  it("gives up after a bounded number of forbidden answers", async () => {
    let calls = 0;
    const listen = async () => {
      calls += 1;
      return 3000;
    };
    await expect(pickPort(listen)).rejects.toThrow(/port/i);
    expect(calls).toBe(20);
  });

  it("lists the dev stack's ports as forbidden", () => {
    expect([...FORBIDDEN_PORTS]).toEqual([3000, 3001, 5433, 6380, 9000]);
  });

  it("asks the OS for a real, free, allowed port by default", async () => {
    const port = await pickPort();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
    expect(FORBIDDEN_PORTS).not.toContain(port);
  });
});
