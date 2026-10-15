import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LIST_ITEM } from "@/lib/commands/guard";
import {
  useListCursor,
  type CursorItem,
  type ListCursor,
} from "@/lib/commands/use-list-cursor";

type Api = { current: ListCursor | null };

interface HarnessProps {
  ids: string[];
  api: Api;
  initialId?: string | null;
  /** Each item holds a button of its own (a step card's Undo). */
  inner?: boolean;
  /** The consumer puts its own `onFocus` over the item's. */
  ownOnFocus?: boolean;
  /** Gets the cursor each render saw. */
  seen?: (string | null)[];
  /**
   * An item removed from the page reports a blur first, as some browsers do
   * while the commit takes it out (`relatedTarget` null).
   */
  blurOnRemove?: boolean;
}

/** A list page: a control before the list, the list, a control after it. */
function Harness({
  ids,
  api,
  initialId,
  inner = false,
  ownOnFocus = false,
  seen,
  blurOnRemove = false,
}: HarnessProps) {
  const listRef = useRef<HTMLUListElement>(null);
  const items: CursorItem[] = ids.map((id) => ({ id }));
  const cursor = useListCursor({ items, initialId, listRef });
  api.current = cursor;
  seen?.push(cursor.cursorId);
  return (
    <div>
      <button type="button">before</button>
      <ul ref={listRef}>
        {ids.map((id) => (
          <li
            key={id}
            data-testid={`item-${id}`}
            ref={
              blurOnRemove
                ? (el) => () => {
                    el?.dispatchEvent(
                      new FocusEvent("focusout", {
                        bubbles: true,
                        relatedTarget: null,
                      }),
                    );
                  }
                : undefined
            }
            {...cursor.itemProps(id)}
            {...(ownOnFocus ? { onFocus: () => undefined } : {})}
          >
            {id}
            {inner && <button type="button">{`Undo ${id}`}</button>}
          </li>
        ))}
      </ul>
      <button type="button">after</button>
    </div>
  );
}

/**
 * A run row holding its step cards, both of them items (the batch page may
 * nest them): focus inside a step is the step's, not the run's.
 */
function Nested({ api }: { api: Api }) {
  const listRef = useRef<HTMLDivElement>(null);
  const cursor = useListCursor({
    items: [{ id: "run:1" }, { id: "step:1" }, { id: "step:2" }],
    listRef,
  });
  api.current = cursor;
  return (
    <div ref={listRef}>
      <div data-testid="run" {...cursor.itemProps("run:1")}>
        run
        <div data-testid="step-1" {...cursor.itemProps("step:1")}>
          <button type="button">Undo step 1</button>
        </div>
        <div data-testid="step-2" {...cursor.itemProps("step:2")}>
          step 2
        </div>
      </div>
    </div>
  );
}

/**
 * Two lists, one inside an item of the other. Each hook owns the items it was
 * given: the outer one is handed `a`, `b` and `c`, the inner one `inner:1`.
 */
function Inside({
  outer,
  inner,
  seen,
}: {
  outer: Api;
  inner: Api;
  seen?: (string | null)[];
}) {
  const outerRef = useRef<HTMLUListElement>(null);
  const innerRef = useRef<HTMLUListElement>(null);
  const outerCursor = useListCursor({
    items: [{ id: "a" }, { id: "b" }, { id: "c" }],
    listRef: outerRef,
  });
  const innerCursor = useListCursor({
    items: [{ id: "inner:1" }],
    listRef: innerRef,
  });
  outer.current = outerCursor;
  inner.current = innerCursor;
  seen?.push(outerCursor.cursorId);
  return (
    <ul ref={outerRef}>
      <li data-testid="item-a" {...outerCursor.itemProps("a")}>
        a
      </li>
      <li data-testid="item-b" {...outerCursor.itemProps("b")}>
        b
        <ul ref={innerRef}>
          <li data-testid="item-inner:1" {...innerCursor.itemProps("inner:1")}>
            inner
          </li>
        </ul>
      </li>
      <li data-testid="item-c" {...outerCursor.itemProps("c")}>
        c
      </li>
    </ul>
  );
}

/** Two sibling lists on one page, each with a cursor of its own. */
function Siblings({ left, right }: { left: Api; right: Api }) {
  const leftRef = useRef<HTMLUListElement>(null);
  const rightRef = useRef<HTMLUListElement>(null);
  const leftCursor = useListCursor({
    items: [{ id: "l1" }, { id: "l2" }, { id: "l3" }],
    listRef: leftRef,
  });
  const rightCursor = useListCursor({
    items: [{ id: "r1" }, { id: "r2" }, { id: "r3" }],
    listRef: rightRef,
  });
  left.current = leftCursor;
  right.current = rightCursor;
  return (
    <div>
      <ul ref={leftRef}>
        {["l1", "l2", "l3"].map((id) => (
          <li key={id} data-testid={`item-${id}`} {...leftCursor.itemProps(id)}>
            {id}
          </li>
        ))}
      </ul>
      <ul ref={rightRef}>
        {["r1", "r2", "r3"].map((id) => (
          <li
            key={id}
            data-testid={`item-${id}`}
            {...rightCursor.itemProps(id)}
          >
            {id}
          </li>
        ))}
      </ul>
    </div>
  );
}

const item = (id: string): HTMLElement => screen.getByTestId(`item-${id}`);
const button = (name: string): HTMLElement =>
  screen.getByRole("button", { name });

/** The ids of the list items Tab stops on. */
function tabStops(): (string | null)[] {
  return Array.from(document.querySelectorAll<HTMLElement>(LIST_ITEM))
    .filter((el) => el.tabIndex === 0)
    .map((el) => el.getAttribute("data-cursor-id"));
}

function cursorOf(api: Api): ListCursor {
  if (api.current === null) throw new Error("the harness has not rendered");
  return api.current;
}

let scrollSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  scrollSpy.mockRestore();
});

describe.each([
  ["", false],
  [" (StrictMode)", true],
])("useListCursor%s", (_label, strict) => {
  const opts = { reactStrictMode: strict };

  it("one tab stop", async () => {
    const user = userEvent.setup();
    const api: Api = { current: null };
    render(<Harness ids={["a", "b", "c"]} api={api} />, opts);

    // No cursor yet: the first item is the list's one Tab stop.
    expect(cursorOf(api).cursorId).toBeNull();
    expect(tabStops()).toEqual(["a"]);

    act(() => cursorOf(api).setCursor("b"));
    expect(tabStops()).toEqual(["b"]);
    expect(item("a").tabIndex).toBe(-1);
    expect(item("c").tabIndex).toBe(-1);

    // Tab enters the list at the cursor and leaves it in one step.
    act(() => button("before").focus());
    await user.tab();
    expect(document.activeElement).toBe(item("b"));
    await user.tab();
    expect(document.activeElement).toBe(button("after"));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(item("b"));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(button("before"));
  });

  it("next with no cursor focuses the first item", () => {
    const api: Api = { current: null };
    render(<Harness ids={["a", "b", "c"]} api={api} />, opts);
    expect(document.activeElement).toBe(document.body);

    act(() => cursorOf(api).next());
    expect(document.activeElement).toBe(item("a"));
    expect(cursorOf(api).cursorId).toBe("a");
    expect(tabStops()).toEqual(["a"]);
  });

  it("prev with no cursor also focuses the first item", () => {
    const api: Api = { current: null };
    render(<Harness ids={["a", "b", "c"]} api={api} />, opts);

    act(() => cursorOf(api).prev());
    expect(document.activeElement).toBe(item("a"));
    expect(cursorOf(api).cursorId).toBe("a");
  });

  it("next/prev/first/last move focus", () => {
    const api: Api = { current: null };
    render(<Harness ids={["a", "b", "c", "d"]} api={api} />, opts);

    const expectAt = (id: string) => {
      expect(document.activeElement).toBe(item(id));
      expect(cursorOf(api).cursorId).toBe(id);
      expect(tabStops()).toEqual([id]);
      // Brought into view the least it takes, at once: never smooth.
      expect(scrollSpy).toHaveBeenLastCalledWith({ block: "nearest" });
      expect(scrollSpy.mock.contexts.at(-1)).toBe(item(id));
    };

    act(() => cursorOf(api).next());
    expectAt("a");
    act(() => cursorOf(api).next());
    expectAt("b");
    act(() => cursorOf(api).last());
    expectAt("d");
    // The ends hold: no wrap.
    act(() => cursorOf(api).next());
    expectAt("d");
    act(() => cursorOf(api).prev());
    expectAt("c");
    act(() => cursorOf(api).first());
    expectAt("a");
    act(() => cursorOf(api).prev());
    expectAt("a");

    // From focus elsewhere on the page, a move starts at the cursor.
    act(() => cursorOf(api).next());
    act(() => button("after").focus());
    act(() => cursorOf(api).next());
    expectAt("c");

    for (const [opts] of scrollSpy.mock.calls as [ScrollIntoViewOptions][]) {
      expect(opts.behavior).toBeUndefined();
    }
  });

  it("a click or Tab focus sets the cursor", async () => {
    const user = userEvent.setup();
    const api: Api = { current: null };
    render(<Harness ids={["a", "b", "c"]} api={api} />, opts);

    // Tab into the list.
    act(() => button("before").focus());
    await user.tab();
    expect(document.activeElement).toBe(item("a"));
    expect(cursorOf(api).cursorId).toBe("a");

    // A click.
    await user.click(item("c"));
    expect(cursorOf(api).cursorId).toBe("c");
    expect(tabStops()).toEqual(["c"]);

    // A focus handoff from elsewhere ("Back to batch" landing on a row).
    act(() => item("b").focus());
    expect(cursorOf(api).cursorId).toBe("b");
    expect(tabStops()).toEqual(["b"]);
  });

  it("a focus on a descendant of an item sets the cursor to that item", () => {
    const api: Api = { current: null };
    const { unmount } = render(
      <Harness ids={["a", "b", "c"]} api={api} inner />,
      opts,
    );

    // A step card moving focus to its Undo after a decision.
    act(() => button("Undo b").focus());
    expect(cursorOf(api).cursorId).toBe("b");
    expect(tabStops()).toEqual(["b"]);
    act(() => button("Undo c").focus());
    expect(cursorOf(api).cursorId).toBe("c");
    unmount();

    // Seen even when the consumer's own onFocus replaces the item's.
    render(<Harness ids={["a", "b", "c"]} api={api} inner ownOnFocus />, opts);
    act(() => button("Undo b").focus());
    expect(cursorOf(api).cursorId).toBe("b");
    act(() => item("c").focus());
    expect(cursorOf(api).cursorId).toBe("c");
  });

  it("a focus inside a nested item is the innermost item's", () => {
    const api: Api = { current: null };
    render(<Nested api={api} />, opts);

    act(() => button("Undo step 1").focus());
    expect(cursorOf(api).cursorId).toBe("step:1");
    act(() => screen.getByTestId("run").focus());
    expect(cursorOf(api).cursorId).toBe("run:1");
    act(() => screen.getByTestId("step-2").focus());
    expect(cursorOf(api).cursorId).toBe("step:2");
  });

  it("survives a refetch that reorders items", () => {
    const api: Api = { current: null };
    const { rerender } = render(
      <Harness ids={["a", "b", "c", "d"]} api={api} />,
      opts,
    );
    act(() => cursorOf(api).setCursor("c", true));
    expect(document.activeElement).toBe(item("c"));

    rerender(<Harness ids={["d", "c", "b", "a"]} api={api} />);
    expect(cursorOf(api).cursorId).toBe("c");
    expect(tabStops()).toEqual(["c"]);
    expect(document.activeElement).toBe(item("c"));

    // Moves walk the new order.
    act(() => cursorOf(api).next());
    expect(document.activeElement).toBe(item("b"));

    // The cursor moved to the front, then its item went: it takes the
    // place the item last had, the front.
    rerender(<Harness ids={["b", "a", "d", "c"]} api={api} />);
    expect(cursorOf(api).cursorId).toBe("b");
    rerender(<Harness ids={["a", "d", "c"]} api={api} />);
    expect(cursorOf(api).cursorId).toBe("a");
    expect(document.activeElement).toBe(item("a"));
  });

  it("when its item disappears the cursor moves to the same index", () => {
    const api: Api = { current: null };
    const { rerender } = render(
      <Harness ids={["a", "b", "c", "d"]} api={api} inner />,
      opts,
    );
    act(() => cursorOf(api).setCursor("b", true));

    // b (index 1) drops out: c now holds index 1, and focus goes with it.
    rerender(<Harness ids={["a", "c", "d"]} api={api} inner />);
    expect(cursorOf(api).cursorId).toBe("c");
    expect(tabStops()).toEqual(["c"]);
    expect(document.activeElement).toBe(item("c"));

    // Focus on a button inside the item counts as focus in the list.
    act(() => button("Undo c").focus());
    rerender(<Harness ids={["a", "d"]} api={api} inner />);
    expect(cursorOf(api).cursorId).toBe("d");
    expect(document.activeElement).toBe(item("d"));

    // The last item goes: the cursor takes the new last one.
    rerender(<Harness ids={["a"]} api={api} inner />);
    expect(cursorOf(api).cursorId).toBe("a");
    expect(tabStops()).toEqual(["a"]);
    expect(document.activeElement).toBe(item("a"));
  });

  it("does not steal focus when the list loses an item while focus is elsewhere", async () => {
    const api: Api = { current: null };
    const { rerender } = render(
      <Harness ids={["a", "b", "c", "d"]} api={api} />,
      opts,
    );
    act(() => cursorOf(api).setCursor("b", true));
    act(() => button("after").focus());

    rerender(<Harness ids={["a", "c", "d"]} api={api} />);
    expect(cursorOf(api).cursorId).toBe("c");
    expect(tabStops()).toEqual(["c"]);
    expect(document.activeElement).toBe(button("after"));

    // Focus let go of (a click on the page's background): not taken back.
    act(() => item("c").focus());
    await act(async () => item("c").blur());
    expect(document.activeElement).toBe(document.body);
    rerender(<Harness ids={["a", "d"]} api={api} />);
    expect(cursorOf(api).cursorId).toBe("d");
    expect(document.activeElement).toBe(document.body);

    // Focus on an item that stays: it stays there too.
    rerender(<Harness ids={["a", "d", "e"]} api={api} />);
    act(() => item("a").focus());
    act(() => cursorOf(api).setCursor("e"));
    rerender(<Harness ids={["a", "d"]} api={api} />);
    expect(cursorOf(api).cursorId).toBe("d");
    expect(document.activeElement).toBe(item("a"));
  });

  it("focus returns when items come back within the loading window", () => {
    vi.useFakeTimers();
    const api: Api = { current: null };
    const { rerender } = render(
      <Harness ids={["a", "b", "c"]} api={api} />,
      opts,
    );
    act(() => cursorOf(api).setCursor("b", true));

    // A filter change: the rows give way to a loading state, then come back.
    rerender(<Harness ids={[]} api={api} />);
    expect(document.activeElement).toBe(document.body);
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    rerender(<Harness ids={["a", "b", "c"]} api={api} />);
    expect(cursorOf(api).cursorId).toBe("b");
    expect(document.activeElement).toBe(item("b"));

    // The window ended while focus was back in the list: it keeps what it
    // knows of where focus is, and still follows its item out.
    act(() => {
      vi.advanceTimersByTime(2500);
    });
    rerender(<Harness ids={["a", "c"]} api={api} />);
    expect(document.activeElement).toBe(item("c"));

    // The item it was on is not among those that come back: the one now at
    // its index gets it.
    rerender(<Harness ids={[]} api={api} />);
    rerender(<Harness ids={["a", "x", "y"]} api={api} />);
    expect(cursorOf(api).cursorId).toBe("x");
    expect(document.activeElement).toBe(item("x"));
  });

  it("an emptied list does not take focus when items arrive later", () => {
    vi.useFakeTimers();
    const api: Api = { current: null };
    const { rerender } = render(
      <Harness ids={["a", "b", "c"]} api={api} />,
      opts,
    );
    act(() => cursorOf(api).setCursor("b", true));

    // Emptied, and the next items arrive long after (an event while the
    // reviewer is elsewhere): nothing takes focus.
    rerender(<Harness ids={[]} api={api} />);
    act(() => {
      vi.advanceTimersByTime(2500);
    });
    rerender(<Harness ids={["a", "b", "c"]} api={api} />);
    expect(document.activeElement).toBe(document.body);
    expect(cursorOf(api).cursorId).toBe("b");
    expect(tabStops()).toEqual(["b"]);
  });

  it.each(["keydown", "pointerdown"])(
    "a %s while the list is empty drops the focus record",
    (type) => {
      vi.useFakeTimers();
      const api: Api = { current: null };
      const { rerender } = render(
        <Harness ids={["a", "b", "c"]} api={api} />,
        opts,
      );
      act(() => cursorOf(api).setCursor("b", true));
      rerender(<Harness ids={[]} api={api} />);

      // Well inside the window, but the reviewer did something else.
      act(() => {
        vi.advanceTimersByTime(300);
        document.body.dispatchEvent(new Event(type, { bubbles: true }));
      });
      rerender(<Harness ids={["a", "b", "c"]} api={api} />);
      expect(document.activeElement).toBe(document.body);
      expect(cursorOf(api).cursorId).toBe("b");
    },
  );

  it("a keydown in a list that still has items keeps the focus record", () => {
    const api: Api = { current: null };
    const { rerender } = render(
      <Harness ids={["a", "b", "c", "d"]} api={api} />,
      opts,
    );
    act(() => cursorOf(api).setCursor("b", true));

    // A reviewer decides with a key and the decided item leaves the list:
    // the key was pressed, yet focus still goes with the item.
    act(() => {
      document.body.dispatchEvent(new Event("keydown", { bubbles: true }));
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    rerender(<Harness ids={["a", "c", "d"]} api={api} />);
    expect(document.activeElement).toBe(item("c"));
  });

  it("focus lost with a non-cursor item returns to the cursor item", () => {
    const api: Api = { current: null };
    const { rerender } = render(
      <Harness ids={["a", "b", "c", "d"]} api={api} />,
      opts,
    );
    // Focus is on c; the cursor was put on a without moving focus.
    act(() => item("c").focus());
    act(() => cursorOf(api).setCursor("a"));
    expect(cursorOf(api).cursorId).toBe("a");
    expect(document.activeElement).toBe(item("c"));

    // c goes: focus has nowhere to be, so it comes to the cursor.
    rerender(<Harness ids={["a", "b", "d"]} api={api} />);
    expect(cursorOf(api).cursorId).toBe("a");
    expect(document.activeElement).toBe(item("a"));
  });

  it("a nested list's focus does not move the outer cursor", () => {
    const outer: Api = { current: null };
    const inner: Api = { current: null };
    const seen: (string | null)[] = [];
    render(<Inside outer={outer} inner={inner} seen={seen} />, opts);
    act(() => cursorOf(outer).setCursor("a"));

    act(() => item("inner:1").focus());
    // The inner list's item is the inner cursor's; the outer cursor never
    // names it, not even for a render.
    expect(cursorOf(inner).cursorId).toBe("inner:1");
    expect(cursorOf(outer).cursorId).toBe("a");
    expect(seen).not.toContain("inner:1");
    expect(
      Array.from(document.querySelectorAll<HTMLElement>(LIST_ITEM))
        .filter((el) => el.tabIndex === 0)
        .map((el) => el.getAttribute("data-cursor-id")),
    ).toEqual(["a", "inner:1"]);

    // An outer item still takes the outer cursor.
    act(() => item("c").focus());
    expect(cursorOf(outer).cursorId).toBe("c");
    expect(cursorOf(inner).cursorId).toBe("inner:1");
  });

  it("an item removed with a blur reported during the commit still hands focus on", () => {
    const api: Api = { current: null };
    const { rerender } = render(
      <Harness ids={["a", "b", "c", "d"]} api={api} blurOnRemove />,
      opts,
    );
    act(() => cursorOf(api).setCursor("b", true));
    expect(document.activeElement).toBe(item("b"));

    // The browser reports the blur (nothing receives focus) as b is taken
    // out; that is no click on the page's background.
    rerender(<Harness ids={["a", "c", "d"]} api={api} blurOnRemove />);
    expect(cursorOf(api).cursorId).toBe("c");
    expect(document.activeElement).toBe(item("c"));
  });

  it("two sibling lists keep separate cursors", () => {
    const left: Api = { current: null };
    const right: Api = { current: null };
    render(<Siblings left={left} right={right} />, opts);

    act(() => cursorOf(left).next());
    act(() => cursorOf(left).next());
    expect(cursorOf(left).cursorId).toBe("l2");
    expect(cursorOf(right).cursorId).toBeNull();

    act(() => cursorOf(right).last());
    expect(cursorOf(right).cursorId).toBe("r3");
    expect(cursorOf(left).cursorId).toBe("l2");
    expect(document.activeElement).toBe(item("r3"));

    // Each list's Tab stop is its own cursor.
    expect(
      Array.from(document.querySelectorAll<HTMLElement>(LIST_ITEM))
        .filter((el) => el.tabIndex === 0)
        .map((el) => el.getAttribute("data-cursor-id")),
    ).toEqual(["l2", "r3"]);

    // Focus in one list never sets the other's cursor, and moves from the
    // other's cursor do not start from this one's.
    act(() => item("l3").focus());
    expect(cursorOf(left).cursorId).toBe("l3");
    expect(cursorOf(right).cursorId).toBe("r3");
    act(() => cursorOf(right).prev());
    expect(document.activeElement).toBe(item("r2"));
    expect(cursorOf(left).cursorId).toBe("l3");
  });

  it("initialId places the cursor without focusing", () => {
    const api: Api = { current: null };
    render(<Harness ids={["a", "b", "c"]} api={api} initialId="b" />, opts);

    expect(cursorOf(api).cursorId).toBe("b");
    expect(tabStops()).toEqual(["b"]);
    expect(document.activeElement).toBe(document.body);
    expect(scrollSpy).not.toHaveBeenCalled();

    act(() => cursorOf(api).next());
    expect(document.activeElement).toBe(item("c"));
  });

  it("an initialId waits for the list to load, and one it never holds is dropped", () => {
    const api: Api = { current: null };
    const { rerender } = render(
      <Harness ids={[]} api={api} initialId="b" />,
      opts,
    );
    expect(cursorOf(api).cursorId).toBe("b");

    rerender(<Harness ids={["a", "b", "c"]} api={api} initialId="b" />);
    expect(cursorOf(api).cursorId).toBe("b");
    expect(tabStops()).toEqual(["b"]);
    cleanup();

    render(<Harness ids={["a", "b"]} api={api} initialId="zz" />, opts);
    expect(cursorOf(api).cursorId).toBeNull();
    expect(tabStops()).toEqual(["a"]);
  });

  it("setCursor moves focus only when asked, and ignores an id the list doesn't hold", () => {
    const api: Api = { current: null };
    const seen: (string | null)[] = [];
    render(<Harness ids={["a", "b", "c"]} api={api} seen={seen} />, opts);

    act(() => cursorOf(api).setCursor("c"));
    expect(cursorOf(api).cursorId).toBe("c");
    expect(document.activeElement).toBe(document.body);
    expect(scrollSpy).not.toHaveBeenCalled();

    act(() => cursorOf(api).setCursor("zz", true));
    expect(cursorOf(api).cursorId).toBe("c");
    expect(document.activeElement).toBe(document.body);
    // Not even for a render.
    expect(seen).not.toContain("zz");

    act(() => cursorOf(api).setCursor("b", true));
    expect(document.activeElement).toBe(item("b"));
    expect(scrollSpy).toHaveBeenLastCalledWith({ block: "nearest" });
  });

  it("marks items with exactly the attribute the guard's LIST_ITEM selects", () => {
    const api: Api = { current: null };
    render(<Harness ids={["a", "b"]} api={api} />, opts);

    expect(document.querySelectorAll(LIST_ITEM)).toHaveLength(2);
    expect(item("a").matches(LIST_ITEM)).toBe(true);
    expect(cursorOf(api).itemProps("a")).toEqual({
      tabIndex: 0,
      "data-cursor-id": "a",
      onFocus: expect.any(Function),
    });
  });

  it("binds no keys", () => {
    const api: Api = { current: null };
    render(<Harness ids={["a", "b", "c"]} api={api} />, opts);
    act(() => cursorOf(api).setCursor("b", true));

    for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "j", "k"]) {
      fireEvent.keyDown(item("b"), { key });
    }
    expect(cursorOf(api).cursorId).toBe("b");
    expect(document.activeElement).toBe(item("b"));
  });
});
