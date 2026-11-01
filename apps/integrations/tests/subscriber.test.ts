import { EventEmitter } from "node:events";

import type { DB } from "@furan/db";
import type { Redis } from "ioredis";
import type { App } from "octokit";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { handleRunCompleted } from "../src/run-events/handle-run-completed.js";
import { startRunEventsSubscriber } from "../src/run-events/subscriber.js";
import { enqueueWebhookDeliveries } from "../src/webhooks/enqueue.js";

vi.mock("../src/run-events/handle-run-completed.js", () => ({
  handleRunCompleted: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/webhooks/enqueue.js", () => ({
  enqueueWebhookDeliveries: vi.fn().mockResolvedValue({ enqueued: 0 }),
}));

function fakeRedis() {
  const emitter = new EventEmitter() as EventEmitter & {
    psubscribe: ReturnType<typeof vi.fn>;
    punsubscribe: ReturnType<typeof vi.fn>;
  };
  emitter.psubscribe = vi.fn();
  emitter.punsubscribe = vi.fn().mockResolvedValue(undefined);
  return emitter;
}

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: () => log,
};

const completed = JSON.stringify({ type: "run.completed", runId: "run-1" });

const reviewed = JSON.stringify({
  type: "run.reviewed",
  runId: "run-1",
  payload: {},
  ts: 1,
});

beforeEach(() => {
  vi.mocked(handleRunCompleted).mockClear();
  vi.mocked(enqueueWebhookDeliveries).mockClear();
});

describe("startRunEventsSubscriber → run.reviewed (a review moved a run's status)", () => {
  function start(extra: { githubApp?: App } = {}) {
    const redis = fakeRedis();
    const db = {} as DB;
    startRunEventsSubscriber({
      redis: redis as unknown as Redis,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: log as any,
      db,
      webhookQueue: {} as never,
      dashboardBaseUrl: "https://furan.example.com",
      ...extra,
    });
    return { redis, db };
  }

  test("refreshes GitHub for the run, from the stored run, with the same db and links", () => {
    const githubApp = {} as App;
    const { redis, db } = start({ githubApp });

    redis.emit("pmessage", "run:*:events", "run:run-1:events", reviewed);

    expect(handleRunCompleted).toHaveBeenCalledTimes(1);
    expect(handleRunCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        githubApp,
        db,
        dashboardBaseUrl: "https://furan.example.com",
        // Normalised to the handler's event shape; the status is read from the run.
        event: { type: "run.completed", runId: "run-1" },
      }),
    );
  });

  test("never reaches Slack or the outbound webhooks", () => {
    const { redis } = start({ githubApp: {} as App });
    redis.emit("pmessage", "run:*:events", "run:run-1:events", reviewed);
    expect(enqueueWebhookDeliveries).not.toHaveBeenCalled();
  });

  test("does nothing without a GitHub App, and not for a frame with no run id", () => {
    const noApp = start();
    noApp.redis.emit("pmessage", "run:*:events", "run:run-1:events", reviewed);
    const withApp = start({ githubApp: {} as App });
    withApp.redis.emit(
      "pmessage",
      "run:*:events",
      "run:x:events",
      JSON.stringify({ type: "run.reviewed", payload: {} }),
    );
    expect(handleRunCompleted).not.toHaveBeenCalled();
  });

  test("run.completed still reaches both the GitHub handler and the webhooks", () => {
    const { redis } = start({ githubApp: {} as App });
    redis.emit("pmessage", "run:*:events", "run:run-1:events", completed);
    expect(handleRunCompleted).toHaveBeenCalledTimes(1);
    expect(enqueueWebhookDeliveries).toHaveBeenCalledTimes(1);
  });

  test("one memo is shared by every call of a subscriber, so repeats are not reposted", () => {
    const { redis } = start({ githubApp: {} as App });
    redis.emit("pmessage", "run:*:events", "run:run-1:events", reviewed);
    redis.emit("pmessage", "run:*:events", "run:run-2:events", completed);

    const memos = vi
      .mocked(handleRunCompleted)
      .mock.calls.map(([opts]) => opts.postMemo);
    expect(memos).toHaveLength(2);
    expect(memos[0]).toBeDefined();
    expect(memos[0]).toBe(memos[1]);
  });
});

describe("startRunEventsSubscriber → GitHub handler wiring", () => {
  test("hands the handler the database and the dashboard base URL", () => {
    const redis = fakeRedis();
    const db = {} as DB;
    const githubApp = {} as App;
    startRunEventsSubscriber({
      redis: redis as unknown as Redis,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: log as any,
      githubApp,
      db,
      dashboardBaseUrl: "https://furan.example.com",
    });

    redis.emit("pmessage", "run:*:events", "run:run-1:events", completed);

    expect(handleRunCompleted).toHaveBeenCalledTimes(1);
    expect(handleRunCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        githubApp,
        db,
        dashboardBaseUrl: "https://furan.example.com",
        event: expect.objectContaining({ runId: "run-1" }),
      }),
    );
  });

  test("without a GitHub App the handler is not called", () => {
    const redis = fakeRedis();
    startRunEventsSubscriber({
      redis: redis as unknown as Redis,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: log as any,
      db: {} as DB,
    });
    redis.emit("pmessage", "run:*:events", "run:run-1:events", completed);
    expect(handleRunCompleted).not.toHaveBeenCalled();
  });

  test("other event types never reach the GitHub handler", () => {
    const redis = fakeRedis();
    startRunEventsSubscriber({
      redis: redis as unknown as Redis,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: log as any,
      githubApp: {} as App,
      db: {} as DB,
    });
    redis.emit(
      "pmessage",
      "run:*:events",
      "run:run-1:events",
      JSON.stringify({ type: "run.checkpoint_diffed", runId: "run-1" }),
    );
    expect(handleRunCompleted).not.toHaveBeenCalled();
  });
});
