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
vi.mock("@/components/tour/page-tour", () => ({ PageTour: () => null }));
// The viewer's role, as the server reads it for the request.
const session = vi.hoisted(() => ({ role: "editor" as string }));
vi.mock("@/lib/get-viewer", async () => {
  const roles =
    await vi.importActual<typeof import("@/lib/roles")>("@/lib/roles");
  return { ...roles, getViewerRole: vi.fn(async () => session.role) };
});

import CheckpointPage from "@/app/(protected)/projects/[projectId]/runs/[runId]/checkpoints/[checkpointId]/page";

beforeEach(() => {
  session.role = "editor";
});
afterEach(() => {
  cleanup();
  viewer.props = undefined;
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
});
