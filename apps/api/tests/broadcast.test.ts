import type { Redis } from "@furan/queue";
import { bootstrapTelemetry, type Telemetry } from "@furan/telemetry";
import { describe, expect, test, vi } from "vitest";

import { createBroadcaster } from "../src/lib/broadcast.js";

function makeTelemetry(): Telemetry {
  return bootstrapTelemetry({ service: "broadcast-test", version: "test" });
}

describe("createBroadcaster", () => {
  test("publishProjectEvent publishes JSON-encoded payload to project:<id>:events:raw", async () => {
    const publish = vi.fn().mockResolvedValue(1);
    const redis = { publish } as unknown as Redis;
    const telemetry = makeTelemetry();
    const b = createBroadcaster(redis, telemetry);

    await b.publishProjectEvent("p1", {
      event: "testRun_updated",
      data: { id: "r1", status: "passed" },
    });

    expect(publish).toHaveBeenCalledOnce();
    const [channel, payload] = publish.mock.calls[0]!;
    expect(channel).toBe("project:p1:events:raw");
    const parsed = JSON.parse(payload as string);
    expect(parsed.event).toBe("testRun_updated");
    expect(parsed.data).toEqual({ id: "r1", status: "passed" });
    expect(typeof parsed.ts).toBe("number");
  });

  test("publishProjectEvent swallows Redis errors (best-effort liveness)", async () => {
    const publish = vi.fn().mockRejectedValue(new Error("redis_down"));
    const redis = { publish } as unknown as Redis;
    const telemetry = makeTelemetry();
    const b = createBroadcaster(redis, telemetry);

    // Must not throw — a Redis blip cannot fail an otherwise-successful
    // DB write upstream. The broadcaster logs and returns void.
    await expect(
      b.publishProjectEvent("p1", { event: "build_created", data: {} }),
    ).resolves.toBeUndefined();
  });

  test("each of the nine event names round-trips on the wire shape", async () => {
    const publish = vi.fn().mockResolvedValue(1);
    const redis = { publish } as unknown as Redis;
    const telemetry = makeTelemetry();
    const b = createBroadcaster(redis, telemetry);

    const events = [
      "build_created",
      "build_updated",
      "build_deleted",
      "testRun_created",
      "testRun_updated",
      "testRun_deleted",
      // ADR-038: checkpoint lifecycle events
      "run.checkpoint_added",
      "run.checkpoint_diffed",
      "run.completed",
    ] as const;
    for (const ev of events) {
      await b.publishProjectEvent("p1", { event: ev, data: { x: 1 } });
    }
    expect(publish).toHaveBeenCalledTimes(events.length);
    const observedEvents = publish.mock.calls.map(
      (c) => JSON.parse(c[1] as string).event as string,
    );
    expect(observedEvents.sort()).toEqual([...events].sort());
  });
});
