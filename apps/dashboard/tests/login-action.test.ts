import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The login Server Action runs inside the dashboard container and calls the
 * api's /auth/login server-side. Without forwarding the browser's
 * X-Forwarded-For, the api's per-IP login limit sees every UI login as coming
 * from the dashboard container — one shared bucket for the whole install.
 */

// redirect() throws in real Next to abort the action; emulate it with a
// sentinel so the target can be asserted and execution stops like prod.
class RedirectError extends Error {
  constructor(public to: string) {
    super(`NEXT_REDIRECT:${to}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectError(to);
  },
}));

const incoming = { headers: new Headers() };
const cookieSet = vi.fn();
vi.mock("next/headers", () => ({
  headers: async () => incoming.headers,
  cookies: async () => ({ set: cookieSet }),
}));

// @/lib/auth pulls in `server-only`, which throws outside a react-server
// bundle; the action only needs the cookie name from it.
vi.mock("@/lib/auth", () => ({ JWT_COOKIE: "furan_jwt" }));

import { loginAction } from "@/app/(public)/login/action";

const fetchMock = vi.fn();

function form(email: string, password: string): FormData {
  const fd = new FormData();
  fd.set("email", email);
  fd.set("password", password);
  return fd;
}

function okResponse() {
  return { ok: true, json: async () => ({ token: "jwt-abc" }) };
}

/** Headers object passed on the (single) /auth/login fetch. */
function sentHeaders(): Record<string, string> {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toMatch(/\/auth\/login$/);
  return init.headers as Record<string, string>;
}

async function submitValid() {
  await expect(
    loginAction(undefined, form("user@example.com", "pw")),
  ).rejects.toThrow("NEXT_REDIRECT:/home");
}

beforeEach(() => {
  incoming.headers = new Headers();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(okResponse());
  cookieSet.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loginAction client-IP forwarding", () => {
  test("forwards the incoming x-forwarded-for to the api", async () => {
    incoming.headers = new Headers({ "x-forwarded-for": "203.0.113.7" });
    await submitValid();
    expect(sentHeaders()["x-forwarded-for"]).toBe("203.0.113.7");
  });

  test("forwards a multi-hop / IPv6 list, trimmed", async () => {
    incoming.headers = new Headers({
      "x-forwarded-for": "  2001:db8::1, ::ffff:10.0.0.2, [2001:db8::2]  ",
    });
    await submitValid();
    expect(sentHeaders()["x-forwarded-for"]).toBe(
      "2001:db8::1, ::ffff:10.0.0.2, [2001:db8::2]",
    );
  });

  test("sends no x-forwarded-for when the request has none", async () => {
    await submitValid();
    expect(sentHeaders()).not.toHaveProperty("x-forwarded-for");
  });

  test.each([
    ["non-IP text", "evil.example.com"],
    ["injection attempt", "1.2.3.4\r\nx-admin: 1"],
    ["empty after trim", "   "],
    ["oversized", Array.from({ length: 200 }, () => "10.0.0.1").join(", ")],
  ])("drops an implausible x-forwarded-for (%s)", async (_label, value) => {
    // Headers() rejects CR/LF itself, so build the incoming bag by hand.
    incoming.headers = {
      get: (name: string) =>
        name.toLowerCase() === "x-forwarded-for" ? value : null,
    } as unknown as Headers;
    await submitValid();
    expect(sentHeaders()).not.toHaveProperty("x-forwarded-for");
  });
});

describe("loginAction existing behavior", () => {
  test("invalid input returns invalid_input without calling the api", async () => {
    const res = await loginAction(undefined, form("not-an-email", "pw"));
    expect(res).toEqual({ error: "invalid_input", email: "not-an-email" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("non-ok api response returns invalid_credentials and echoes the email", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) });
    const res = await loginAction(undefined, form("user@example.com", "bad"));
    expect(res).toEqual({
      error: "invalid_credentials",
      email: "user@example.com",
    });
    expect(cookieSet).not.toHaveBeenCalled();
  });

  test("success posts JSON credentials, sets the JWT cookie and redirects", async () => {
    await submitValid();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(sentHeaders()["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      email: "user@example.com",
      password: "pw",
    });
    expect(cookieSet).toHaveBeenCalledWith(
      "furan_jwt",
      "jwt-abc",
      expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/" }),
    );
  });
});
