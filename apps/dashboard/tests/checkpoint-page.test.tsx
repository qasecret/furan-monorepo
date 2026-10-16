import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// The viewer is code-split with next/dynamic (it drags pixi.js in). Swap it
// for a stub that records the props the page hands it.
const viewer = vi.hoisted(() => ({ props: undefined as unknown }));
vi.mock("next/dynamic", () => ({
  default: () =>
    function DiffViewerStub(props: unknown) {
      viewer.props = props;
      return <div data-testid="diff-viewer-stub" />;
    },
}));
// The tour, as the page hands it its steps.
const tour = vi.hoisted(() => ({ steps: [] as { content: string }[] }));
vi.mock("@/components/tour/page-tour", () => ({
  PageTour: ({ steps }: { steps: { content: string }[] }) => {
    tour.steps = steps;
    return null;
  },
}));
// The viewer, as the server reads it for the request.
const session = vi.hoisted(() => ({
  id: "u1" as string | null,
  role: "editor" as string,
}));
vi.mock("@/lib/get-viewer", async () => {
  const roles =
    await vi.importActual<typeof import("@/lib/roles")>("@/lib/roles");
  return {
    ...roles,
    getViewer: vi.fn(async () => ({ id: session.id, role: session.role })),
  };
});

import CheckpointPage from "@/app/(protected)/projects/[projectId]/runs/[runId]/checkpoints/[checkpointId]/page";

beforeEach(() => {
  session.id = "u1";
  session.role = "editor";
});
afterEach(() => {
  cleanup();
  viewer.props = undefined;
  tour.steps = [];
});

/** The server page, rendered as Next renders it: awaited, then mounted. */
async function renderPage(
  searchParams: Record<string, string | string[] | undefined> = {},
) {
  render(
    await CheckpointPage({
      params: Promise.resolve({
        projectId: "p1",
        runId: "r1",
        checkpointId: "c1",
      }),
      searchParams: Promise.resolve(searchParams),
    }),
  );
  expect(screen.getByTestId("diff-viewer-stub")).toBeDefined();
  return viewer.props as Record<string, unknown>;
}

describe("checkpoint page", () => {
  test("opens the step named by the URL", async () => {
    const props = await renderPage();
    expect(props).toMatchObject({
      projectId: "p1",
      runId: "r1",
      initialCheckpointId: "c1",
    });
  });

  test("hands the viewer the URL's review context as one prop", async () => {
    const props = await renderPage({
      status: "failed",
      browser: "chromium",
      viewport: "1280x720",
    });
    expect(props.reviewContext).toEqual({
      status: "failed",
      facets: { browser: "chromium", viewport: "1280x720" },
    });
  });

  test("a URL with no context is the default context", async () => {
    const props = await renderPage();
    expect(props.reviewContext).toEqual({ status: "needs-review", facets: {} });
  });

  test("drops what is not a review context rather than failing", async () => {
    const props = await renderPage({
      status: "bogus",
      utm_source: "mail",
      os: ["macOS", "linux"],
    });
    // A repeated param counts once, by its first value.
    expect(props.reviewContext).toEqual({
      status: "needs-review",
      facets: { os: "macOS" },
    });
  });

  test("hands the viewer canReview from the server's role", async () => {
    // R14: decided on the server, so the first paint already has (or has
    // not) the decision buttons.
    for (const [role, canReview] of [
      ["guest", false],
      ["editor", true],
      ["admin", true],
      ["owner", true],
    ] as const) {
      session.role = role;
      const props = await renderPage();
      expect(props.canReview, role).toBe(canReview);
      cleanup();
    }
  });

  test("hands the viewer the user's id, for their saved preferences", async () => {
    expect((await renderPage()).userId).toBe("u1");
    cleanup();
    // No user behind the session: the viewer keeps preferences in memory.
    session.id = null;
    expect((await renderPage()).userId).toBeNull();
  });

  test("hands the viewer the URL's comparison mode, parsed (spec §6.3)", async () => {
    expect((await renderPage({ status: "failed", view: "swipe" })).view).toBe(
      "swipe",
    );
    cleanup();
    // None, or one that names no mode: no view, and the page still opens.
    for (const view of [undefined, "bogus", ["swipe", "diff"]]) {
      expect((await renderPage({ view })).view, String(view)).toBeNull();
      cleanup();
    }
  });

  test("the viewer's tour names the five comparison modes, and no key (spec §8)", async () => {
    await renderPage();
    const copy = tour.steps.map((s) => s.content).join("\n");
    for (const mode of [
      "Side by side",
      "Swipe",
      "Flicker",
      "Overlay",
      "Diff",
    ]) {
      expect(copy).toContain(mode);
    }
    expect(copy).not.toMatch(/\b[A-Z]\b to/);
    expect(copy).not.toMatch(/candidate-only/i);
  });

  test("the viewer's tour names no keys: a guest has no A, and the switch can turn them off (R35)", async () => {
    await renderPage();
    expect(tour.steps.length).toBeGreaterThan(0);
    for (const { content } of tour.steps) {
      // A key as the copy wrote one ("`A`"), or "Use A to approve".
      expect(content).not.toMatch(/`[^`]{1,3}`/);
      expect(content).not.toMatch(/\b(?:Use|Press) [A-Z]\b/);
      expect(content).not.toMatch(/to approve|to reject|to comment/);
    }
  });
});
