import { Writable } from "node:stream";

import { trace } from "@opentelemetry/api";
import { afterEach, describe, expect, test, vi } from "vitest";

import { bootstrapTelemetry, makeProcessErrorHandlers } from "./index.js";

describe("bootstrapTelemetry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns logger + metrics + shutdown handle", () => {
    const t = bootstrapTelemetry({ service: "test-svc", version: "0.0.1" });
    expect(t.logger).toBeDefined();
    expect(t.metrics).toBeDefined();
    expect(t.shutdown).toBeInstanceOf(Function);
  });

  test("logger emits JSON with service + version base fields", async () => {
    const captured: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        captured.push(chunk.toString());
        cb();
      },
    });

    const t = bootstrapTelemetry({
      service: "test-svc",
      version: "0.0.2",
      destination: stream,
    });
    t.logger.info({ hello: "world" }, "hello message");

    await new Promise((r) => setTimeout(r, 20));
    expect(captured.length).toBeGreaterThan(0);
    const parsed = JSON.parse(captured[0]!);
    expect(parsed.service).toBe("test-svc");
    expect(parsed.version).toBe("0.0.2");
    expect(parsed.hello).toBe("world");
    expect(parsed.msg).toBe("hello message");
  });

  test("redactor masks password / apiKey / Authorization / token", async () => {
    const captured: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        captured.push(chunk.toString());
        cb();
      },
    });

    const t = bootstrapTelemetry({
      service: "test-svc",
      version: "0.0.3",
      destination: stream,
    });
    t.logger.info({
      password: "p4ssw0rd",
      nested: { apiKey: "key-secret" },
      headers: { Authorization: "Bearer xyz", "X-Other": "ok" },
      token: "tok123",
    });

    await new Promise((r) => setTimeout(r, 20));
    const parsed = JSON.parse(captured[0]!);
    expect(parsed.password).toBe("[REDACTED]");
    expect(parsed.nested.apiKey).toBe("[REDACTED]");
    expect(parsed.headers.Authorization).toBe("[REDACTED]");
    expect(parsed.headers["X-Other"]).toBe("ok");
    expect(parsed.token).toBe("[REDACTED]");
  });

  test("metrics registry carries service + version default labels", async () => {
    const t = bootstrapTelemetry({ service: "test-svc", version: "0.0.4" });
    const text = await t.metrics.metrics();
    expect(text).toMatch(/service="test-svc"/);
    expect(text).toMatch(/version="0.0.4"/);
  });

  test("no SDK starts when otlpEndpoint is undefined", async () => {
    const t = bootstrapTelemetry({ service: "test-svc", version: "0.0.5" });
    await expect(t.shutdown()).resolves.toBeUndefined();
  });

  test("log line carries no trace fields when no span is active", async () => {
    const captured: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        captured.push(chunk.toString());
        cb();
      },
    });
    const t = bootstrapTelemetry({
      service: "test-svc",
      version: "0.0.6",
      destination: stream,
    });
    t.logger.info("no span here");
    await new Promise((r) => setTimeout(r, 20));
    const parsed = JSON.parse(captured[0]!);
    expect(parsed.trace_id).toBeUndefined();
    expect(parsed.span_id).toBeUndefined();
  });

  test("log line carries trace_id/span_id when a span is active", async () => {
    const captured: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        captured.push(chunk.toString());
        cb();
      },
    });
    const t = bootstrapTelemetry({
      service: "test-svc",
      version: "0.0.7",
      destination: stream,
    });

    const traceId = "0af7651916cd43dd8448eb211c80319c";
    const spanId = "b7ad6b7169203331";
    // Stub the active span rather than rely on a registered context manager
    // (none is installed without a started SDK, so context.with wouldn't
    // propagate). This still exercises the real pino → mixin → getActiveSpan path.
    vi.spyOn(trace, "getActiveSpan").mockReturnValue(
      trace.wrapSpanContext({ traceId, spanId, traceFlags: 1 }),
    );
    t.logger.info("inside span");

    await new Promise((r) => setTimeout(r, 20));
    const parsed = JSON.parse(captured[0]!);
    expect(parsed.trace_id).toBe(traceId);
    expect(parsed.span_id).toBe(spanId);
  });

  test("all-zero (never-sampled) trace id is not stamped onto logs", async () => {
    const captured: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        captured.push(chunk.toString());
        cb();
      },
    });
    const t = bootstrapTelemetry({
      service: "test-svc",
      version: "0.0.8",
      destination: stream,
    });
    vi.spyOn(trace, "getActiveSpan").mockReturnValue(
      trace.wrapSpanContext({
        traceId: "00000000000000000000000000000000",
        spanId: "0000000000000000",
        traceFlags: 0,
      }),
    );
    t.logger.info("invalid span ctx");
    await new Promise((r) => setTimeout(r, 20));
    const parsed = JSON.parse(captured[0]!);
    expect(parsed.trace_id).toBeUndefined();
  });
});

describe("makeProcessErrorHandlers", () => {
  function captureLogger() {
    const captured: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        captured.push(chunk.toString());
        cb();
      },
    });
    const t = bootstrapTelemetry({
      service: "err-svc",
      version: "1.0.0",
      destination: stream,
    });
    return { logger: t.logger, captured };
  }

  test("unhandledRejection logs and does NOT exit", async () => {
    const { logger, captured } = captureLogger();
    let exitCalls = 0;
    const { onUnhandledRejection } = makeProcessErrorHandlers(logger, {
      exit: () => {
        exitCalls += 1;
      },
    });

    onUnhandledRejection(new Error("stray fire-and-forget"));

    await new Promise((r) => setTimeout(r, 20));
    expect(exitCalls).toBe(0);
    const line = captured.find((c) => c.includes("unhandled_rejection"));
    expect(line).toBeDefined();
    expect(JSON.parse(line!).level).toBe(50); // error, not fatal
  });

  test("uncaughtException logs fatal and exits non-zero", async () => {
    const { logger, captured } = captureLogger();
    const codes: number[] = [];
    const { onUncaughtException } = makeProcessErrorHandlers(logger, {
      exit: (code) => codes.push(code),
    });

    onUncaughtException(new Error("boom"));

    await new Promise((r) => setTimeout(r, 20));
    expect(codes).toEqual([1]); // flushed then exited exactly once
    const line = captured.find((c) => c.includes("uncaught_exception"));
    expect(line).toBeDefined();
    expect(JSON.parse(line!).level).toBe(60); // fatal
  });
});
