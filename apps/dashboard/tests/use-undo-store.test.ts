import { beforeEach, describe, expect, it } from "vitest";

import { useUndoStore } from "../src/lib/review/use-undo-store";

describe("useUndoStore", () => {
  beforeEach(() => useUndoStore.setState({ stack: [] }));

  const entry = (n: number) => ({
    actionId: `action-${n}`,
    label: `Approved ${n}`,
    runIds: [`run-${n}`],
  });

  it("takes the newest entry first", () => {
    useUndoStore.getState().push(entry(1));
    useUndoStore.getState().push(entry(2));

    expect(useUndoStore.getState().take()).toEqual(entry(2));
    expect(useUndoStore.getState().stack).toEqual([entry(1)]);
    expect(useUndoStore.getState().take()).toEqual(entry(1));
    expect(useUndoStore.getState().take()).toBeUndefined();
  });

  it("drops an entry by action id and ignores an unknown id", () => {
    useUndoStore.getState().push(entry(1));
    useUndoStore.getState().push(entry(2));

    useUndoStore.getState().drop("action-1");
    useUndoStore.getState().drop("nope");

    expect(useUndoStore.getState().stack).toEqual([entry(2)]);
  });

  it("keeps the newest 20 entries", () => {
    for (let n = 1; n <= 25; n++) useUndoStore.getState().push(entry(n));

    const { stack } = useUndoStore.getState();
    expect(stack).toHaveLength(20);
    expect(stack[0]).toEqual(entry(6));
    expect(stack[19]).toEqual(entry(25));
  });
});
