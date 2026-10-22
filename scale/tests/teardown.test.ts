import { describe, expect, it } from "vitest";

import { Teardown } from "../src/stack/teardown.js";

describe("Teardown", () => {
  it("runs every step once, in reverse order, even when one throws", async () => {
    const order: string[] = [];
    const teardown = new Teardown();
    teardown.add("a", async () => {
      order.push("a");
    });
    teardown.add("b", async () => {
      order.push("b");
      throw new Error("b failed");
    });
    teardown.add("c", async () => {
      order.push("c");
    });

    const results = await teardown.run();

    expect(order).toEqual(["c", "b", "a"]);
    expect(results).toEqual([
      { name: "c" },
      { name: "b", error: "b failed" },
      { name: "a" },
    ]);

    // A second run does nothing: no step runs again.
    await teardown.run();
    expect(order).toEqual(["c", "b", "a"]);
  });

  it("gives a second, concurrent caller the same results", async () => {
    const order: string[] = [];
    const teardown = new Teardown();
    teardown.add("slow", async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("slow");
    });
    const first = teardown.run();
    const second = teardown.run();
    expect(await second).toEqual(await first);
    expect(order).toEqual(["slow"]);
  });

  it("runs a step added after the run began at once", async () => {
    const order: string[] = [];
    const teardown = new Teardown();
    await teardown.run();
    teardown.add("late", async () => {
      order.push("late");
    });
    expect(await teardown.lateResults()).toEqual([{ name: "late" }]);
    expect(order).toEqual(["late"]);
  });

  it("abandons a step that outlives its timeout and goes on", async () => {
    const order: string[] = [];
    const teardown = new Teardown({ stepTimeoutMs: 20 });
    teardown.add("after", async () => {
      order.push("after");
    });
    teardown.add("hung", () => new Promise<void>(() => {}));
    const results = await teardown.run();
    expect(order).toEqual(["after"]);
    expect(results[0]?.name).toBe("hung");
    expect(results[0]?.error).toMatch(/timed out/);
    expect(results[1]).toEqual({ name: "after" });
  });

  it("never puts a connection string password in a reported error", async () => {
    const teardown = new Teardown();
    teardown.add("db", async () => {
      throw new Error(
        "cannot reach postgres://admin:hunter2@db.example:5432/x",
      );
    });
    const [result] = await teardown.run();
    expect(result?.error).not.toContain("hunter2");
  });
});
