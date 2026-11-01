import { EventEmitter } from "node:events";

import type { DB } from "@furan/db";
import type { Redis } from "ioredis";
import type { App } from "octokit";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { handleRunCompleted } from "../src/run-events/handle-run-completed.js";
import { startRunEventsSubscriber } from "../src/run-events/subscriber.js";

vi.mock("../src/run-events/handle-run-completed.js", () => ({
  handleRunCompleted: vi.fn().mockResolvedValue(undefined),
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

beforeEach(() => {
  vi.mocked(handleRunCompleted).mockClear();
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
