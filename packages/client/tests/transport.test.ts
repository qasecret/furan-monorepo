import { describe, expect, it, vi } from "vitest";

import { FuranApiError, Transport } from "../src/index.js";

const TOKEN = "furan_pat_SECRET123"; // gitleaks:allow (fake test token)

type Reply = Response | Error;

/** A fetch that answers with `replies` in order and records every call. */
function fakeFetch(...replies: Reply[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const reply = replies.shift();
    if (!reply) throw new Error("no more replies");
    if (reply instanceof Error) throw reply;
    return reply;
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

function transport(f: ReturnType<typeof fakeFetch>, apiUrl = "http://h:3000") {
  const sleep = vi.fn(async () => {});
  const t = new Transport({
    apiUrl,
    token: TOKEN,
    fetch: f.fetch,
    sleep,
    random: () => 1,
  });
  return { t, sleep };
}

describe("Transport", () => {
  it("sends bearer, user agent and a request id", async () => {
    const f = fakeFetch(json(200, { ok: true }));
    await transport(f).t.request("GET", "runs/1");
    const headers = new Headers(f.calls[0]!.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headers.get("user-agent")).toMatch(/^furan-js\/\S+ \(node\/v\d+/);
    expect(headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("sends JSON bodies as JSON", async () => {
    const f = fakeFetch(json(201, { id: "b" }));
    await transport(f).t.request("POST", "runs", { a: 1 });
    expect(new Headers(f.calls[0]!.init.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(f.calls[0]!.init.body).toBe('{"a":1}');
  });

  it("transport keeps the api url path prefix", async () => {
    const f = fakeFetch(json(200, {}));
    await transport(f, "http://h:8080/api").t.request("POST", "runs", {});
    expect(f.calls[0]!.url).toBe("http://h:8080/api/runs");
  });

  it("retries 503 then succeeds; sleeps 500 then 1000", async () => {
    const f = fakeFetch(json(503, {}), json(503, {}), json(200, { ok: 1 }));
    const { t, sleep } = transport(f);
    await expect(t.request("GET", "runs/1")).resolves.toEqual({ ok: 1 });
    expect(sleep.mock.calls).toEqual([[500], [1000]]);
  });

  it("honours Retry-After capped at 8s", async () => {
    const f = fakeFetch(json(429, {}, { "retry-after": "30" }), json(200, {}));
    const { t, sleep } = transport(f);
    await t.request("GET", "runs/1");
    expect(sleep.mock.calls).toEqual([[8000]]);
  });

  it("retries network errors up to 3 times then throws a network error", async () => {
    const down = () => new TypeError("fetch failed");
    const f = fakeFetch(down(), down(), down(), down());
    const err = await transport(f)
      .t.request("GET", "runs/1")
      .catch((e: unknown) => e);
    expect(f.calls).toHaveLength(4);
    expect(err).toBeInstanceOf(FuranApiError);
    expect((err as FuranApiError).code).toBe("network_error");
    expect((err as FuranApiError).message).toContain("http://h:3000");
  });

  it.each([400, 401, 403, 404, 409])("does not retry %i", async (status) => {
    const f = fakeFetch(
      json(status, {
        code: "not_a_project_member",
        message: "Not a project member",
        statusCode: status,
      }),
    );
    const err = (await transport(f)
      .t.request("POST", "runs", {})
      .catch((e: unknown) => e)) as FuranApiError;
    expect(f.calls).toHaveLength(1);
    expect(err).toBeInstanceOf(FuranApiError);
    expect(err).toMatchObject({
      status,
      code: "not_a_project_member",
      method: "POST",
      path: "runs",
    });
    expect(err.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("non-JSON response becomes FuranApiError invalid_response with a hint", async () => {
    const f = fakeFetch(
      new Response("<!doctype html><html></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    const err = (await transport(f)
      .t.request("GET", "runs/1")
      .catch((e: unknown) => e)) as FuranApiError;
    expect(err.code).toBe("invalid_response");
    expect(err.message).toContain("FURAN_API_URL");
  });

  it("an error without the envelope still has a code", async () => {
    const f = fakeFetch(json(418, { nope: true }));
    const err = (await transport(f)
      .t.request("GET", "x")
      .catch((e: unknown) => e)) as FuranApiError;
    expect(err.code).toBe("http_418");
  });

  it("a fetch error quoting the auth header never echoes the token", async () => {
    const f = fakeFetch(
      ...Array.from(
        { length: 4 },
        () =>
          new TypeError(
            `Headers.append: "Bearer ${TOKEN}" is an invalid header value.`,
          ),
      ),
    );
    const err = await transport(f)
      .t.request("GET", "runs/1")
      .catch((e: unknown) => e);
    expect(String(err)).not.toContain("SECRET123");
    expect(String(err)).toContain("****");
  });

  it("token never appears in an error message", async () => {
    const f = fakeFetch(
      json(500, {}),
      json(500, {}),
      json(500, {}),
      json(500, {}),
    );
    const err = await transport(f)
      .t.request("GET", "runs/1")
      .catch((e: unknown) => e);
    expect(String(err)).not.toContain("SECRET123");
    expect(JSON.stringify(err)).not.toContain("SECRET123");
  });
});
