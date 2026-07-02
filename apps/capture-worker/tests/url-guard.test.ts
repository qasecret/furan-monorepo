import { describe, expect, it } from "vitest";

import { assertSafeCaptureUrl, SsrfBlockedError } from "../src/url-guard.js";

/** Deterministic resolver seam so tests don't touch real DNS. */
const resolveTo = (ips: string[]) => async () => ips;

describe("assertSafeCaptureUrl", () => {
  it("allows a public https URL", async () => {
    await expect(
      assertSafeCaptureUrl("https://example.com/app", {
        resolve: resolveTo(["93.184.216.34"]),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects non-http(s) schemes", async () => {
    for (const u of [
      "file:///etc/passwd",
      "data:text/html,<h1>x</h1>",
      "gopher://internal",
    ]) {
      await expect(assertSafeCaptureUrl(u)).rejects.toBeInstanceOf(
        SsrfBlockedError,
      );
    }
  });

  it("rejects malformed URLs", async () => {
    await expect(assertSafeCaptureUrl("not a url")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it("ALWAYS blocks the cloud-metadata / link-local range as an IP literal", async () => {
    await expect(
      assertSafeCaptureUrl("http://169.254.169.254/latest/meta-data/"),
    ).rejects.toThrow(/link-local\/metadata/);
  });

  it("ALWAYS blocks a hostname that resolves to metadata (indirect)", async () => {
    await expect(
      assertSafeCaptureUrl("http://evil.example.com/", {
        resolve: resolveTo(["169.254.169.254"]),
      }),
    ).rejects.toThrow(/link-local\/metadata/);
  });

  it("ALWAYS blocks IPv4-mapped IPv6 metadata", async () => {
    await expect(
      assertSafeCaptureUrl("http://host/", {
        resolve: resolveTo(["::ffff:169.254.169.254"]),
      }),
    ).rejects.toThrow(/link-local\/metadata/);
  });

  it("allows loopback/private by default (internal-app capture is legitimate)", async () => {
    await expect(
      assertSafeCaptureUrl("http://localhost:3000/", {
        resolve: resolveTo(["127.0.0.1"]),
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertSafeCaptureUrl("http://10.0.0.5/app"),
    ).resolves.toBeUndefined();
  });

  it("blocks loopback + RFC-1918 + CGNAT + ULA when blockPrivate is on", async () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "192.168.1.9", "100.64.0.1"]) {
      await expect(
        assertSafeCaptureUrl(`http://${ip}/`, { blockPrivate: true }),
      ).rejects.toThrow(/private address/);
    }
    await expect(
      assertSafeCaptureUrl("http://[fd12::1]/", { blockPrivate: true }),
    ).rejects.toThrow(/private address/);
  });

  it("passes through when DNS cannot resolve (navigation will fail naturally)", async () => {
    await expect(
      assertSafeCaptureUrl("http://nope.invalid/", {
        resolve: async () => {
          throw new Error("ENOTFOUND");
        },
      }),
    ).resolves.toBeUndefined();
  });
});
