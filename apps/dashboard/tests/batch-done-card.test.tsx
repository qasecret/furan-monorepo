import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// The card is presentational: it says what is done and offers the way on.
// Esc is its own (the router is mocked); Continue and Clear filter are the
// review loop's, which "Continue keeps the facets" wires in for real.
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

/** What the live `review.next` query answers, for the wired card. */
const query = vi.hoisted(() => ({ data: undefined as unknown }));
const utils = vi.hoisted(() => ({
  review: { next: { fetch: vi.fn() } },
  runs: {
    getById: { prefetch: vi.fn(), getData: vi.fn(), fetch: vi.fn() },
    listCheckpoints: { prefetch: vi.fn() },
  },
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => utils,
    review: {
      next: {
        useQuery: () => ({
          data: query.data,
          isLoading: false,
          isFetching: false,
          isError: false,
          error: null,
          refetch: vi.fn(),
        }),
      },
    },
  },
}));

import { BatchDoneCard } from "@/components/diff-viewer/BatchDoneCard";
import {
  ReviewAnnouncer,
  useReviewAnnouncer,
} from "@/lib/review/review-announcer";
import { useLoopCue, useReviewLoop } from "@/lib/review/use-review-loop";
import type { ReviewContext } from "@/lib/review-context";

type Props = ComponentProps<typeof BatchDoneCard>;

const NEXT_BATCH = {
  buildId: "b2",
  name: "Nightly",
  number: 43,
  branch: "main",
  pending: 5,
};
const BACK = "/projects/p1/builds/b1?browser=chromium#run-r1";
const BATCHES = "/inbox?status=failed";
const CONTINUE = "Continue to build #43 · main · 5 pending";

function props(over: Partial<Props> = {}): Props {
  return {
    variant: "batch",
    nextBatch: NEXT_BATCH,
    batchUnfiltered: 0,
    onContinue: vi.fn(),
    onClearFilter: vi.fn(),
    backHref: BACK,
    batchesHref: BATCHES,
    ...over,
  };
}

function renderCard(over: Partial<Props> = {}) {
  const p = props(over);
  return { ...render(<BatchDoneCard {...p} />), props: p };
}

beforeEach(() => {
  router.push.mockReset();
  router.replace.mockReset();
  utils.review.next.fetch.mockReset();
  query.data = undefined;
  useReviewAnnouncer.setState({ text: "", seq: 0 });
  useLoopCue.setState({ cue: null });
});

afterEach(() => {
  cleanup();
});

describe("BatchDoneCard", () => {
  test("batch variant: title Batch done, primary 'Continue to build #43 · main · 5 pending →' focused, Enter continues", async () => {
    const user = userEvent.setup();
    const { getByRole, queryByRole, props: p } = renderCard();
    // A dialog named by its title.
    const dialog = getByRole("dialog", { name: "Batch done" });
    const titleId = dialog.getAttribute("aria-labelledby");
    expect(document.getElementById(titleId!)?.textContent).toBe("Batch done");
    // The primary action: the arrow is seen, not read.
    const next = getByRole("button", { name: CONTINUE });
    expect(next.textContent).toBe(`${CONTINUE} →`);
    expect(next.querySelector('[aria-hidden="true"]')?.textContent).toBe("→");
    expect(document.activeElement).toBe(next);
    // Nothing is left outside the filters, and there is more to review.
    expect(queryByRole("button", { name: /Clear filter/ })).toBeNull();
    expect(queryByRole("link", { name: "Back to batches" })).toBeNull();
    expect(
      getByRole("link", { name: "Back to batch" }).getAttribute("href"),
    ).toBe(BACK);

    // Enter is the focused button's own.
    await user.keyboard("{Enter}");
    expect(p.onContinue).toHaveBeenCalledOnce();
    expect(p.onClearFilter).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  test("Continue names a batch with no number, drops a missing branch, and counts one as 1 pending", () => {
    const { getByRole } = renderCard({
      nextBatch: { ...NEXT_BATCH, number: null, branch: null, pending: 1 },
    });
    expect(
      getByRole("button", { name: "Continue to Nightly · 1 pending" }),
    ).toBeDefined();
  });

  test("filtered variant: 'Done with the filtered steps' + 'Clear filter (4 more in this batch)'", () => {
    const { getByRole, props: p } = renderCard({
      variant: "filtered",
      batchUnfiltered: 4,
    });
    getByRole("dialog", { name: "Done with the filtered steps" });
    // Continue still leads; Clear filter follows it.
    expect(document.activeElement).toBe(
      getByRole("button", { name: CONTINUE }),
    );
    fireEvent.click(
      getByRole("button", { name: "Clear filter (4 more in this batch)" }),
    );
    expect(p.onClearFilter).toHaveBeenCalledOnce();
    expect(p.onContinue).not.toHaveBeenCalled();
    cleanup();

    // No next batch inside the filters: Clear filter takes the focus.
    const again = renderCard({
      variant: "filtered",
      batchUnfiltered: 1,
      nextBatch: null,
    });
    expect(document.activeElement).toBe(
      again.getByRole("button", {
        name: "Clear filter (1 more in this batch)",
      }),
    );
  });

  test("all variant: All caught up + Back to batches", () => {
    const { getByRole, queryByRole } = renderCard({
      variant: "all",
      nextBatch: null,
    });
    const dialog = getByRole("dialog", { name: "All caught up" });
    const bodyId = dialog.getAttribute("aria-describedby");
    expect(document.getElementById(bodyId!)?.textContent).toBe(
      "Nothing needs review in this project.",
    );
    const batches = getByRole("link", { name: "Back to batches" });
    expect(batches.getAttribute("href")).toBe(BATCHES);
    expect(document.activeElement).toBe(batches);
    // Back to batch stays, as Esc does.
    expect(
      getByRole("link", { name: "Back to batch" }).getAttribute("href"),
    ).toBe(BACK);
    expect(queryByRole("button", { name: /Continue/ })).toBeNull();
    expect(queryByRole("button", { name: /Clear filter/ })).toBeNull();
  });

  test("Esc goes back to the batch", () => {
    for (const variant of ["batch", "filtered", "all"] as const) {
      router.push.mockReset();
      const { getByRole } = renderCard({ variant, batchUnfiltered: 2 });
      const from = document.activeElement!;
      expect(getByRole("dialog").contains(from)).toBe(true);
      const esc = createEvent.keyDown(from, { key: "Escape" });
      fireEvent(from, esc);
      expect(router.push).toHaveBeenCalledOnce();
      expect(router.push).toHaveBeenCalledWith(BACK);
      // Nothing else takes it (the viewer's own Esc yields).
      expect(esc.defaultPrevented).toBe(true);
      // Held down, it does not go twice.
      fireEvent.keyDown(from, { key: "Escape", repeat: true });
      expect(router.push).toHaveBeenCalledOnce();
      // The link says so.
      expect(
        getByRole("link", { name: "Back to batch" }).getAttribute(
          "aria-keyshortcuts",
        ),
      ).toBe("Escape");
      cleanup();
    }

    // Also with focus on the card itself (a click on its body).
    const { getByRole } = renderCard();
    router.push.mockReset();
    const dialog = getByRole("dialog");
    act(() => dialog.focus());
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(router.push).toHaveBeenCalledWith(BACK);
  });

  test("announced via a polite live region", () => {
    const page = (card?: Partial<Props>) => (
      <>
        <ReviewAnnouncer />
        {card ? <BatchDoneCard {...props(card)} /> : null}
      </>
    );
    // Strict mode runs the card's effects twice: it is still said once.
    const r = render(page({}), { reactStrictMode: true });
    const region = r.getByTestId("review-announcer");
    expect(region.getAttribute("role")).toBe("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe(`Batch done. ${CONTINUE}.`);
    expect(useReviewAnnouncer.getState().seq).toBe(1);
    // The one polite region on the page: the card brings none of its own.
    expect(r.container.querySelectorAll("[aria-live]")).toHaveLength(1);

    // Once per time it appears: a fresh count is not said again...
    r.rerender(page({ nextBatch: { ...NEXT_BATCH, pending: 4 } }));
    expect(useReviewAnnouncer.getState().seq).toBe(1);
    // ...but the card going (an undo) and coming back is.
    r.rerender(page());
    r.rerender(page({ variant: "all", nextBatch: null }));
    expect(useReviewAnnouncer.getState().seq).toBe(2);
    expect(region.textContent).toBe("All caught up. Back to batches.");

    // Its primary action is the one said: Clear filter, with no next batch.
    r.rerender(page());
    r.rerender(
      page({ variant: "filtered", batchUnfiltered: 3, nextBatch: null }),
    );
    expect(region.textContent).toBe(
      "Done with the filtered steps. Clear filter (3 more in this batch).",
    );
  });

  test("Clear filter is the filtered card's: the batch card shows none, whatever the count", () => {
    // A count from before a teammate took the last of them.
    const { queryByRole } = renderCard({
      variant: "batch",
      batchUnfiltered: 3,
    });
    expect(queryByRole("button", { name: /Clear filter/ })).toBeNull();
  });

  test("no nextBatch → no Continue button", () => {
    const { getByRole, queryByRole } = renderCard({ nextBatch: null });
    getByRole("dialog", { name: "Batch done" });
    expect(queryByRole("button", { name: /Continue/ })).toBeNull();
    // Any card with no Continue offers Back to batches instead, and it leads.
    const batches = getByRole("link", { name: "Back to batches" });
    expect(batches.getAttribute("href")).toBe(BATCHES);
    expect(document.activeElement).toBe(batches);
    expect(getByRole("link", { name: "Back to batch" })).toBeDefined();
    cleanup();

    // On the filtered card too, after Clear filter.
    const filtered = renderCard({
      variant: "filtered",
      batchUnfiltered: 2,
      nextBatch: null,
    });
    const links = filtered.getAllByRole("link").map((a) => a.textContent ?? "");
    expect(links).toEqual(["Back to batches", "Back to batch"]);
  });

  test("its entrance is animated only when motion is allowed", () => {
    const { getByRole } = renderCard();
    const animated = getByRole("dialog")
      .className.split(/\s+/)
      .filter((c) => /animat/.test(c));
    expect(animated.length).toBeGreaterThan(0);
    for (const c of animated) expect(c.startsWith("motion-safe:")).toBe(true);
  });
});

describe("BatchDoneCard, wired to the review loop", () => {
  const FACETED: ReviewContext = {
    status: "failed",
    facets: { browser: "chromium", viewport: "1280x720" },
  };

  /** The viewer's wiring, in small: a decision, then the card it brings. */
  function Viewer({ context }: { context: ReviewContext }) {
    const loop = useReviewLoop({
      projectId: "p1",
      buildId: "b1",
      runId: "r1",
      checkpointId: "c1",
      context,
      enabled: true,
    });
    return (
      <>
        <button type="button" onClick={loop.afterDecision}>
          Approve
        </button>
        {loop.card ? (
          <BatchDoneCard
            variant={loop.card}
            nextBatch={loop.next?.nextBatch ?? null}
            batchUnfiltered={loop.next?.remaining.batchUnfiltered ?? 0}
            onContinue={loop.continueToNextBatch}
            onClearFilter={loop.clearFilter}
            backHref={BACK}
            batchesHref={BATCHES}
          />
        ) : null}
      </>
    );
  }

  test("Continue keeps the facets", async () => {
    const user = userEvent.setup();
    query.data = {
      target: { buildId: "b2", runId: "r9", checkpointId: "s9" },
      scope: "nextBatch",
      remaining: { run: 0, batch: 0, batchUnfiltered: 0, projectBatches: 2 },
      nextBatch: NEXT_BATCH,
    };
    const r = render(<Viewer context={FACETED} />);
    fireEvent.click(r.getByRole("button", { name: "Approve" }));
    expect(document.activeElement).toBe(
      r.getByRole("button", { name: CONTINUE }),
    );
    await user.keyboard("{Enter}");
    expect(router.push).toHaveBeenCalledOnce();
    expect(router.push).toHaveBeenCalledWith(
      "/projects/p1/runs/r9/checkpoints/s9?status=failed&browser=chromium&viewport=1280x720",
    );
    expect(router.replace).not.toHaveBeenCalled();
    // The card is put away.
    expect(r.queryByRole("dialog")).toBeNull();
  });
});
