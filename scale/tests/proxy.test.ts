import { createHash } from "node:crypto";
import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type RequestListener,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { startProxy } from "../src/stack/proxy.js";
import { Teardown } from "../src/stack/teardown.js";

const servers: Server[] = [];
const stops: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** A tiny upstream on a free loopback port. */
async function upstream(
  listener: RequestListener,
): Promise<{ url: string; port: number }> {
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, port };
}

/** A loopback URL nothing listens on. */
async function deadUrl(): Promise<string> {
  const { url } = await upstream(() => undefined);
  const server = servers.pop() as Server;
  await new Promise((resolve) => server.close(resolve));
  return url;
}

/** Echoes what the upstream saw, tagged with who it is. */
function echo(name: string): RequestListener {
  return (req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        upstream: name,
        method: req.method,
        path: req.url,
        headers: req.headers,
      }),
    );
  };
}

interface Seen {
  upstream: string;
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function send(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string> | undefined;
  } = {},
  body?: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: options.method ?? "GET",
        headers: options.headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function seen(url: string, headers?: Record<string, string>) {
  const reply = await send(url, { headers });
  expect(reply.status).toBe(200);
  return JSON.parse(reply.body) as Seen;
}

async function proxyFor(
  apiUrl: string,
  dashboardUrl: string,
  teardown?: Teardown,
) {
  const proxy = await startProxy(apiUrl, dashboardUrl, teardown);
  stops.push(proxy.stop);
  return proxy;
}

describe("single-origin proxy", () => {
  it("proxy strips /api and routes the rest", async () => {
    const api = await upstream(echo("api"));
    const dashboard = await upstream(echo("dashboard"));
    const proxy = await proxyFor(api.url, dashboard.url);

    const runs = await seen(`${proxy.url}/api/runs/1?x=1&y=2`);
    expect(runs.upstream).toBe("api");
    expect(runs.path).toBe("/runs/1?x=1&y=2");

    const inbox = await seen(`${proxy.url}/inbox`);
    expect(inbox.upstream).toBe("dashboard");
    expect(inbox.path).toBe("/inbox");

    // Exactly one /api is stripped: the SSE routes live under /api/v1 on the
    // api, and the dashboard's base is /api.
    const events = await seen(`${proxy.url}/api/api/v1/projects/p1/events`);
    expect(events.upstream).toBe("api");
    expect(events.path).toBe("/api/v1/projects/p1/events");

    // The bare prefix is the api's root; a path that only starts with the
    // letters is the dashboard's.
    expect((await seen(`${proxy.url}/api`)).path).toBe("/");
    const apiary = await seen(`${proxy.url}/apiary`);
    expect(apiary.upstream).toBe("dashboard");
    expect(apiary.path).toBe("/apiary");
  });

  it("forwards the method and the body of a write to the right upstream", async () => {
    const api = await upstream((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () =>
        res.end(`${req.method} ${req.url} ${Buffer.concat(chunks).toString()}`),
      );
    });
    const dashboard = await upstream(echo("dashboard"));
    const proxy = await proxyFor(api.url, dashboard.url);

    const reply = await send(
      `${proxy.url}/api/runs`,
      { method: "POST", headers: { "content-type": "application/json" } },
      '{"a":1}',
    );
    expect(reply.body).toBe('POST /runs {"a":1}');
  });

  it("forwards host and cookies, and overwrites x-forwarded-for", async () => {
    const api = await upstream(echo("api"));
    const dashboard = await upstream(echo("dashboard"));
    const proxy = await proxyFor(api.url, dashboard.url);
    const host = new URL(proxy.url).host;

    for (const path of ["/api/users/me", "/inbox"]) {
      const saw = await seen(`${proxy.url}${path}`, {
        cookie: "session=abc; theme=dark",
        "x-forwarded-for": "6.6.6.6, 7.7.7.7",
      });
      expect(saw.headers.host).toBe(host);
      expect(saw.headers.cookie).toBe("session=abc; theme=dark");
      expect(saw.headers["x-forwarded-for"]).toBe("127.0.0.1");
      expect(saw.headers["x-forwarded-proto"]).toBe("http");
    }

    // The dashboard gets the original host too (the Server Actions origin
    // check compares it with the browser's Origin), as the nginx config does.
    const inbox = await seen(`${proxy.url}/inbox`);
    expect(inbox.headers["x-forwarded-host"]).toBe(host);
  });

  it("does not forward hop-by-hop headers", async () => {
    const api = await upstream(echo("api"));
    const dashboard = await upstream(echo("dashboard"));
    const proxy = await proxyFor(api.url, dashboard.url);

    const saw = await seen(`${proxy.url}/inbox`, {
      connection: "keep-alive, x-private",
      "x-private": "secret",
      "keep-alive": "timeout=5",
      te: "trailers",
    });
    expect(saw.headers["x-private"]).toBeUndefined();
    expect(saw.headers["keep-alive"]).toBeUndefined();
    expect(saw.headers.te).toBeUndefined();
  });

  it("passes the status, the headers and every set-cookie back", async () => {
    const api = await upstream((_req, res) => {
      res.statusCode = 201;
      res.setHeader("set-cookie", ["a=1; Path=/; HttpOnly", "b=2; Path=/"]);
      res.setHeader("x-custom", "yes");
      res.end("created");
    });
    const dashboard = await upstream(echo("dashboard"));
    const proxy = await proxyFor(api.url, dashboard.url);

    const reply = await send(`${proxy.url}/api/auth/login`, { method: "POST" });
    expect(reply.status).toBe(201);
    expect(reply.headers["set-cookie"]).toEqual([
      "a=1; Path=/; HttpOnly",
      "b=2; Path=/",
    ]);
    expect(reply.headers["x-custom"]).toBe("yes");
    expect(reply.body).toBe("created");
  });

  it("proxy streams SSE", async () => {
    let secondWrittenAt = 0;
    const api = await upstream((req, res) => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      res.write("data: one\n\n");
      const timer = setTimeout(() => {
        secondWrittenAt = performance.now();
        res.write("data: two\n\n");
        res.end();
      }, 200);
      req.on("close", () => clearTimeout(timer));
    });
    const dashboard = await upstream(echo("dashboard"));
    const proxy = await proxyFor(api.url, dashboard.url);

    const frames: Array<{ data: string; at: number }> = [];
    let contentType: string | undefined;
    let connection: string | undefined;
    await new Promise<void>((resolve, reject) => {
      // A browser's EventSource asks for a persistent connection.
      const req = request(
        `${proxy.url}/api/api/v1/runs/r1/events`,
        { agent: false, headers: { connection: "keep-alive" } },
        (res) => {
          contentType = res.headers["content-type"];
          connection = res.headers.connection;
          res.setEncoding("utf8");
          res.on("data", (data: string) =>
            frames.push({ data, at: performance.now() }),
          );
          res.on("end", resolve);
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end();
    });

    expect(contentType).toBe("text/event-stream");
    expect(connection).toBe("keep-alive");
    expect(frames.map((frame) => frame.data)).toEqual([
      "data: one\n\n",
      "data: two\n\n",
    ]);
    // The first frame reached the client before the second was written: the
    // proxy did not hold the stream back.
    expect(frames[0]!.at).toBeLessThan(secondWrittenAt);
  });

  it("streams request and response bodies without buffering them", async () => {
    // A full-duplex echo: the upstream writes each chunk back as it arrives.
    const received: number[] = [];
    const api = await upstream((req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      req.on("data", (chunk: Buffer) => {
        received.push(chunk.length);
        res.write(chunk);
      });
      req.on("end", () => res.end());
    });
    const dashboard = await upstream(echo("dashboard"));
    const proxy = await proxyFor(api.url, dashboard.url);

    const chunk = Buffer.alloc(4 * 1024 * 1024, 7);
    const sentHash = createHash("sha256");
    const echoedHash = createHash("sha256");
    let echoedBytes = 0;
    let echoedBeforeSecondChunk = 0;

    await new Promise<void>((resolve, reject) => {
      const req = request(
        `${proxy.url}/api/upload`,
        { method: "POST", agent: false },
        (res) => {
          res.on("data", (data: Buffer) => {
            echoedBytes += data.length;
            echoedHash.update(data);
          });
          res.on("end", resolve);
          res.on("error", reject);
        },
      );
      req.on("error", reject);

      // Chunk 1, then wait for it to come back before writing chunk 2: only a
      // proxy that streams in both directions lets the echo through while the
      // upload is still open.
      req.write(chunk);
      sentHash.update(chunk);
      const wait = setInterval(() => {
        if (echoedBytes >= chunk.length) {
          clearInterval(wait);
          echoedBeforeSecondChunk = echoedBytes;
          req.write(chunk);
          sentHash.update(chunk);
          req.end(chunk);
          sentHash.update(chunk);
        }
      }, 10);
      const giveUp = setTimeout(() => {
        clearInterval(wait);
        reject(new Error("the echo of the first chunk never arrived"));
        req.destroy();
      }, 10_000);
      req.on("close", () => clearTimeout(giveUp));
    });

    expect(echoedBeforeSecondChunk).toBeGreaterThanOrEqual(chunk.length);
    expect(echoedBytes).toBe(chunk.length * 3);
    expect(received.reduce((a, b) => a + b, 0)).toBe(chunk.length * 3);
    expect(echoedHash.digest("hex")).toBe(sentHash.digest("hex"));
  });

  it("answers 502 when an upstream is down and keeps serving", async () => {
    const dashboard = await upstream(echo("dashboard"));
    const proxy = await proxyFor(await deadUrl(), dashboard.url);

    const get = await send(`${proxy.url}/api/runs/1`);
    expect(get.status).toBe(502);

    // A write whose body is still arriving when the upstream refuses.
    const post = await send(
      `${proxy.url}/api/runs`,
      { method: "POST", headers: { "content-type": "text/plain" } },
      "x".repeat(200_000),
    );
    expect(post.status).toBe(502);

    const inbox = await send(`${proxy.url}/inbox`);
    expect(inbox.status).toBe(200);
  });

  it("survives an upstream that dies mid-response", async () => {
    const api = await upstream((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: partial\n\n");
      setTimeout(() => req.socket.destroy(), 50);
    });
    const dashboard = await upstream(echo("dashboard"));
    const proxy = await proxyFor(api.url, dashboard.url);

    const complete = await new Promise<boolean>((resolve) => {
      const req = request(
        `${proxy.url}/api/api/v1/runs/r1/events`,
        { agent: false },
        (res) => {
          res.resume();
          res.on("close", () => resolve(res.complete));
        },
      );
      req.on("error", () => resolve(false));
      req.end();
    });
    expect(complete).toBe(false);

    expect((await send(`${proxy.url}/inbox`)).status).toBe(200);
  });

  it("closes the upstream stream when the client goes away", async () => {
    let upstreamClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      upstreamClosed = resolve;
    });
    const api = await upstream((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: hello\n\n");
      res.on("close", upstreamClosed);
    });
    const dashboard = await upstream(echo("dashboard"));
    const proxy = await proxyFor(api.url, dashboard.url);

    await new Promise<void>((resolve, reject) => {
      const req = request(
        `${proxy.url}/api/api/v1/runs/r1/events`,
        { agent: false },
        (res) => {
          res.once("data", () => {
            req.destroy();
            resolve();
          });
        },
      );
      req.on("error", () => undefined);
      const giveUp = setTimeout(
        () => reject(new Error("no first frame")),
        5_000,
      );
      req.on("close", () => clearTimeout(giveUp));
      req.end();
    });

    await Promise.race([
      closed,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("the upstream stream was left open")),
          5_000,
        ).unref(),
      ),
    ]);
  });

  it("registers on the teardown, which closes open streams and the port", async () => {
    const api = await upstream((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: hello\n\n");
      req.on("close", () => res.end());
    });
    const dashboard = await upstream(echo("dashboard"));
    const teardown = new Teardown();
    const proxy = await proxyFor(api.url, dashboard.url, teardown);

    const ended = new Promise<void>((resolve) => {
      const req = request(
        `${proxy.url}/api/api/v1/runs/r1/events`,
        { agent: false },
        (res) => {
          res.resume();
          res.on("close", () => resolve());
        },
      );
      req.on("error", () => resolve());
      req.end();
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const results = await teardown.run();
    expect(results.filter((r) => r.error !== undefined)).toEqual([]);
    expect(results).toHaveLength(1);
    await ended;
    await expect(send(`${proxy.url}/inbox`)).rejects.toThrow();
  });

  it("listens on loopback and never on a dev-stack port", async () => {
    const api = await upstream(echo("api"));
    const dashboard = await upstream(echo("dashboard"));
    const proxy = await proxyFor(api.url, dashboard.url);
    const url = new URL(proxy.url);
    expect(url.hostname).toBe("127.0.0.1");
    expect([3000, 3001, 5433, 6380, 9000]).not.toContain(Number(url.port));
  });
});
