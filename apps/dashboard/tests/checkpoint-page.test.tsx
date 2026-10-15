import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

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

import CheckpointPage from "@/app/(protected)/projects/[projectId]/runs/[runId]/checkpoints/[checkpointId]/page";

afterEach(() => {
  cleanup();
  viewer.props = undefined;
});

/** A promise React's `use` reads without suspending (status already set). */
function resolved<T>(value: T): Promise<T> {
  const p = Promise.resolve(value) as Promise<T> & {
    status: string;
    value: T;
  };
  p.status = "fulfilled";
  p.value = value;
  return p;
}

function renderPage(
  searchParams: Record<string, string | string[] | undefined> = {},
) {
  render(
    <CheckpointPage
      params={resolved({ projectId: "p1", runId: "r1", checkpointId: "c1" })}
      searchParams={resolved(searchParams)}
    />,
  );
  expect(screen.getByTestId("diff-viewer-stub")).toBeDefined();
  return viewer.props as Record<string, unknown>;
}

describe("checkpoint page", () => {
  test("opens the step named by the URL", () => {
    const props = renderPage();
    expect(props).toMatchObject({
      projectId: "p1",
      runId: "r1",
      initialCheckpointId: "c1",
    });
  });

  test("hands the viewer the URL's review context as one prop", () => {
    const props = renderPage({
      status: "failed",
      browser: "chromium",
      viewport: "1280x720",
    });
    expect(props.reviewContext).toEqual({
      status: "failed",
      facets: { browser: "chromium", viewport: "1280x720" },
    });
  });

  test("a URL with no context is the default context", () => {
    const props = renderPage();
    expect(props.reviewContext).toEqual({ status: "needs-review", facets: {} });
  });

  test("drops what is not a review context rather than failing", () => {
    const props = renderPage({
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
});
