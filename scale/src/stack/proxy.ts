import {
  createServer,
  request,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { pipeline } from "node:stream";

import { pickPort } from "../ports.js";

import type { Teardown } from "./teardown.js";

export interface RunningProxy {
  /** The one origin the browser uses, e.g. `http://127.0.0.1:41234`. */
  url: string;
  stop(): Promise<void>;
}

/** The address the proxy tells both upstreams the client has. */
const CLIENT_ADDRESS = "127.0.0.1";

/** What nginx keeps its idle client connections for (`keepalive_timeout`). */
const KEEP_ALIVE_MS = 75_000;

/** Headers that belong to one connection, never to the message (RFC 9110 7.6.1). */
const HOP_BY_HOP: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  // Answered by this proxy's own server; the upstream never needs it.
  "expect",
]);

type Target = "api" | "dashboard";

/**
 * Where a request goes, and the path it goes with. `/api` and `/api/...` go to
 * the api with exactly one `/api` taken off, as nginx's
 * `location /api/ { proxy_pass http://api:3000/; }` does; the api's own
 * `/api/v1/...` SSE routes are therefore reached as `/api/api/v1/...`.
 * Everything else, including a path that only starts with the letters
 * (`/apiary`), goes to the dashboard unchanged.
 */
export function routeOf(url: string): { target: Target; path: string } {
  const cut = url.search(/[?#]/);
  const pathname = cut === -1 ? url : url.slice(0, cut);
  const rest = cut === -1 ? "" : url.slice(cut);
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return {
      target: "api",
      path: `${pathname.slice("/api".length) || "/"}${rest}`,
    };
  }
  return { target: "dashboard", path: url };
}

/** The headers of a message minus the hop-by-hop ones (and whatever `Connection` names). */
function messageHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const named = new Set(
    String(headers.connection ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token !== ""),
  );
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(name) || named.has(name)) continue;
    out[name] = value;
  }
  return out;
}

const isEventStream = (headers: IncomingHttpHeaders): boolean =>
  String(headers["content-type"] ?? "").startsWith("text/event-stream");

const wantsKeepAlive = (req: IncomingMessage): boolean =>
  req.httpVersion !== "1.0" &&
  !String(req.headers.connection ?? "")
    .toLowerCase()
    .includes("close");

/**
 * The one origin production serves the dashboard on (nginx in
 * `infra/docker/furan-compose.yml`): `/api/*` goes to the api with the prefix
 * stripped, everything else to the dashboard. A browser that talks to this
 * port never makes a cross-origin call, which is what the dashboard's baked-in
 * `/api` base assumes.
 *
 * It does what that nginx config does and no more:
 * - `Host` and cookies pass through both ways, `X-Forwarded-For` is replaced
 *   (never appended to) and `X-Forwarded-Proto` is set; the dashboard also gets
 *   `X-Forwarded-Host`, which its Server Actions compare with the browser's
 *   `Origin`;
 * - bodies are streamed in both directions without buffering (uploads of tens
 *   of megabytes, and server-sent events that must reach the browser the
 *   moment they are written);
 * - each request gets its own connection to the upstream (nginx's default), so
 *   an idle upstream socket the other side has just closed can never fail a
 *   request;
 * - an upstream that cannot be reached or dies mid-response is a 502 or a cut
 *   connection for that one request; the proxy keeps serving.
 *
 * Listens on a free loopback port (never one of FORBIDDEN_PORTS). The stop is
 * registered on `teardown` as soon as the port is bound.
 */
export async function startProxy(
  apiUrl: string,
  dashboardUrl: string,
  teardown?: Teardown,
): Promise<RunningProxy> {
  const upstreams: Record<Target, URL> = {
    api: new URL(apiUrl),
    dashboard: new URL(dashboardUrl),
  };
  const inflight = new Set<ClientRequest>();

  const fail = (res: ServerResponse, req: IncomingMessage, target: Target) => {
    // Let the rest of an upload go by so the client reads our answer.
    req.resume();
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const body = `bad gateway: the ${target} did not answer\n`;
    res.writeHead(502, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      connection: "close",
    });
    res.end(body);
  };

  const server = createServer({ noDelay: true }, (req, res) => {
    const { target, path } = routeOf(req.url ?? "/");
    const upstream = upstreams[target];

    const headers = messageHeaders(req.headers);
    headers["x-forwarded-for"] = CLIENT_ADDRESS;
    headers["x-forwarded-proto"] = "http";
    if (target === "dashboard" && req.headers.host !== undefined) {
      headers["x-forwarded-host"] = req.headers.host;
    }

    const proxied = request({
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port,
      method: req.method,
      path,
      headers,
      agent: false,
    });
    inflight.add(proxied);
    proxied.once("close", () => inflight.delete(proxied));

    proxied.once("response", (answer) => {
      const outgoing = messageHeaders(answer.headers);
      if (isEventStream(answer.headers) && wantsKeepAlive(req)) {
        outgoing.connection = "keep-alive";
      }
      res.writeHead(answer.statusCode ?? 502, answer.statusMessage, outgoing);
      // Headers first, so a stream's client knows it is connected before any
      // event is written.
      res.flushHeaders();
      pipeline(answer, res, () => {
        // A cut upstream leaves the client with a cut response, not a hang.
        if (!res.writableFinished) res.destroy();
      });
    });
    proxied.on("error", () => fail(res, req, target));

    // The client going away (mid-upload or mid-stream) ends the upstream
    // request, which is what closes an event stream on the api's side.
    res.once("close", () => {
      if (!res.writableFinished) proxied.destroy();
    });
    // `pipe`, not `pipeline`: when the upstream fails, the request must stay
    // open long enough for the 502 to be sent on its connection.
    req.pipe(proxied);
  });
  server.keepAliveTimeout = KEEP_ALIVE_MS;
  server.headersTimeout = KEEP_ALIVE_MS + 5_000;

  const port = await pickPort();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  // A late socket error must not take the harness down.
  server.on("error", () => undefined);
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    else socket.destroy();
  });

  const { port: bound } = server.address() as AddressInfo;
  let stopped: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopped ??= new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const proxied of inflight) proxied.destroy();
      // Open event streams and idle keep-alive connections would hold close().
      server.closeAllConnections();
    });
    return stopped;
  };
  teardown?.add("stop the proxy", stop);

  return { url: `http://127.0.0.1:${bound}`, stop };
}
