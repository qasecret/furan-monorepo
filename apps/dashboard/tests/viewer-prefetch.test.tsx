/**
 * The viewer's reads (spec 2026-10-27 §5, budget R4): the run header, the
 * step list, and one step at a time (`runs.getStep`), with the steps either
 * side of it in the rail fetched ahead. Over a real tRPC client and
 * react-query cache whose "server" is a function (`TrpcBackend`), so a test
 * sees every call the viewer makes, and when.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  // Not `screen`: the stage mock's Application has a `screen` of its own,
  // which vitest's mock hoisting would take for this import.
  screen as ui,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  callsTo,
  createBackend,
  TrpcBackend,
  type Backend,
} from "./trpc-backend";

const { routerSpies } = vi.hoisted(() => ({
  routerSpies: { push: vi.fn(), replace: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => routerSpies,
  usePathname: () => "",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({
      href,
      children,
      ...rest
    }: {
      href: string;
      children: ReactNode;
    }) => createElement("a", { href, ...rest }, children),
  };
});
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
// The stage's canvases: inert display objects (WebGL is not what is tested).
vi.mock("pixi.js", () => {
  const point = () => ({ set: () => {} });
  class Container {
    label = "";
    alpha = 1;
    eventMode = "passive";
    cursor = "";
    scale = point();
    position = point();
    children: unknown[] = [];
    addChild<T>(c: T): T {
      this.children.push(c);
      return c;
    }
    removeChild<T>(c: T): T {
      this.children = this.children.filter((x) => x !== c);
      return c;
    }
    on() {
      return this;
    }
    destroy() {}
  }
  class Graphics extends Container {
    rect() {
      return this;
    }
    fill() {
      return this;
    }
    stroke() {
      return this;
    }
    clear() {
      return this;
    }
  }
  return {
    Application: class {
      canvas = document.createElement("canvas");
      stage = new Container();
      screen = { width: 600, height: 400 };
      ticker = { add: () => {}, remove: () => {} };
      async init() {}
      destroy() {}
    },
    Assets: { load: async () => ({}) },
    Sprite: Container,
    Container,
    Graphics,
    Text: Container,
    Texture: { from: () => ({ destroy: () => {} }) },
  };
});

// The run's events: no frame arrives in these tests.
class SilentEventSource {
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource =
  SilentEventSource;

import { DiffViewer } from "@/components/diff-viewer/DiffViewer";
import { CommandRoleProvider } from "@/lib/commands/registry";
import { trpc } from "@/lib/trpc";

const RUN = "00000000-0000-4000-8000-000000000001";
const STEPS = ["c1", "c2", "c3", "c4"] as const;
const NAMES: Record<string, string> = {
  c1: "Home",
  c2: "Search",
  c3: "Cart",
  c4: "Checkout",
};
const AT = "2026-10-27T09:00:00.000Z";

/** The run header (`runs.getById`). */
const HEADER = {
  id: RUN,
  projectId: "p1",
  buildId: "b1",
  name: "Checkout flow",
  status: "unresolved",
  statusOverride: null,
  branchName: "main",
  diffName: null,
  diffPercent: null,
  vlmDescription: null,
  baselineName: null,
  comment: null,
  diffThresholdOverride: null,
  createdAt: AT,
  updatedAt: AT,
  runByName: "Mem Ber",
  autoApproved: false,
};

/** A decision someone else made on a step, as each read reports it. */
const OTHERS_APPROVAL = {
  id: "decision-9",
  actionId: "action-9",
  kind: "approved",
  actor: { id: "user-9", name: "Grace" },
  at: AT,
  source: "viewer",
  legacy: false,
  undo: { allowed: false, reason: "not_decider" },
};

/** What the server holds: each step's review, which a test may change. */
interface Held {
  decided: Set<string>;
}

/** A step of the step list (`runs.listCheckpoints`). */
const listed = (id: string, held: Held) => ({
  id,
  name: NAMES[id],
  viewport: "1280x720",
  browser: "chromium",
  os: `os-${id}`,
  device: null,
  imageKey: `img-${id}`,
  diffFailedAt: null,
  diffError: null,
  verdict: "unresolved",
  state: held.decided.has(id) ? "approved" : "unresolved",
  decision: held.decided.has(id)
    ? {
        actionId: OTHERS_APPROVAL.actionId,
        kind: "approved",
        undo: { allowed: false },
      }
    : null,
  newerCapture: null,
});

/** One step as the viewer reads it (`runs.getStep`). */
const stepRead = (id: string, held: Held) => ({
  step: {
    id,
    runId: RUN,
    name: NAMES[id],
    viewport: "1280x720",
    browser: "chromium",
    os: `os-${id}`,
    device: null,
    matchLevel: "strict",
    imageKey: `img-${id}`,
    diffImageKey: `diff-${id}`,
    elementMapKey: null,
    diffPercent: 1.5,
    diffGeneration: 1,
    vlmDescription: null,
    testVariationId: `variation-${id}`,
    diffFailedAt: null,
    diffError: null,
    verdict: "unresolved",
    createdAt: AT,
  },
  baselineContext: {
    baselineScreenshot: { id: `base-${id}`, imageKey: `base-${id}` },
    baselineSource: "this_branch",
    variationIgnoreAreas: null,
  },
  regions: [],
  review: {
    verdict: "unresolved",
    state: held.decided.has(id) ? "approved" : "unresolved",
    decision: held.decided.has(id) ? OTHERS_APPROVAL : null,
  },
  newerCapture: null,
});

/** A server holding the run of four steps, nothing decided yet. */
function runServer(): { backend: Backend; held: Held } {
  const held: Held = { decided: new Set() };
  const backend = createBackend();
  backend.answer = async ({ path, input }) => {
    switch (path) {
      case "runs.getById":
        return HEADER;
      case "runs.listCheckpoints":
        return { items: STEPS.map((id) => listed(id, held)) };
      case "runs.getStep":
        return stepRead(String(input.checkpointId), held);
      case "projects.getById":
        return {
          id: "p1",
          name: "App",
          dynamicTextEnabled: false,
          diffThreshold: null,
        };
      case "review.next":
        return {
          target: null,
          scope: "batch",
          remaining: {
            run: 0,
            batch: 0,
            batchUnfiltered: 0,
            projectBatches: 0,
          },
          nextBatch: null,
        };
      case "runs.getCheckpointGroup":
        return {
          checkpoints: [],
          checkpointCount: 0,
          runCount: 0,
          capped: false,
        };
      case "builds.getById":
        return { id: "b1", runByName: "Mem Ber" };
      default:
        return { items: [], nextCursor: null };
    }
  };
  return { backend, held };
}

/** The step reads asked for, by step id, in order. */
const stepReads = (backend: Backend): string[] =>
  callsTo(backend, "runs.getStep").map((c) => String(c.checkpointId));

/** The step's OS, as the INFO sidebar shows it: from the step's own read. */
const sidebarOs = (id: string) => ui.queryByText(`os-${id}`);

let utils: ReturnType<typeof trpc.useUtils> | undefined;
function Utils() {
  utils = trpc.useUtils();
  return null;
}

function viewer(backend: Backend, step: string) {
  return (
    <TrpcBackend backend={backend}>
      <CommandRoleProvider role="editor">
        <Utils />
        <DiffViewer
          // The route remounts the viewer on every step.
          key={step}
          runId={RUN}
          projectId="p1"
          initialCheckpointId={step}
          canReview
          userId={null}
        />
      </CommandRoleProvider>
    </TrpcBackend>
  );
}

beforeEach(() => {
  routerSpies.push.mockReset();
  routerSpies.replace.mockReset();
  // The step's images are never answered: nothing reaches the network.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => {})),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  utils = undefined;
});

describe("the viewer reads one step", () => {
  test("opening a step fetches getStep for it and never builds.getById", async () => {
    const { backend } = runServer();
    render(viewer(backend, "c2"));

    // The step on screen is its own read's: its environment in the sidebar.
    expect(await ui.findByText("os-c2")).toBeDefined();
    expect(callsTo(backend, "runs.getStep")).toContainEqual({
      runId: RUN,
      checkpointId: "c2",
    });
    // "Run by" is the run header's: no read of the build.
    expect(ui.getByText("Mem Ber")).toBeDefined();
    expect(callsTo(backend, "runs.getById")).toEqual([{ runId: RUN }]);
    expect(callsTo(backend, "builds.getById")).toEqual([]);
  });

  test("the next and previous steps are prefetched", async () => {
    const { backend } = runServer();
    render(viewer(backend, "c2"));
    await ui.findByText("os-c2");

    // In the rail's order: c3 next, c1 previous. Not c4, two steps away.
    await waitFor(() =>
      expect(stepReads(backend).sort()).toEqual(["c1", "c2", "c3"]),
    );
    await act(async () => {});
    // Each asked for once.
    expect(stepReads(backend).sort()).toEqual(["c1", "c2", "c3"]);
  });

  test("moving to the next step renders from the prefetched step without a new getStep round trip", async () => {
    const { backend } = runServer();
    const r = render(viewer(backend, "c2"));
    await ui.findByText("os-c2");
    await waitFor(() => expect(stepReads(backend)).toContain("c3"));
    await act(async () => {});

    // → in the viewer: c3 is on screen at once, from the cache.
    fireEvent.click(ui.getByTestId("diff-viewer-step-next"));
    expect(sidebarOs("c3")).not.toBeNull();
    expect(ui.queryByText("Loading…")).toBeNull();
    expect(routerSpies.replace).toHaveBeenCalledWith(
      expect.stringContaining(`/runs/${RUN}/checkpoints/c3`),
    );

    // The route commits and remounts the viewer on c3: still the cache.
    r.rerender(viewer(backend, "c3"));
    expect(sidebarOs("c3")).not.toBeNull();
    expect(ui.queryByText("Loading…")).toBeNull();
    // Its own neighbours: c4 is fetched ahead; c2 is fresh in the cache.
    await waitFor(() => expect(stepReads(backend)).toContain("c4"));
    await act(async () => {});
    const reads = stepReads(backend);
    expect(reads.filter((id) => id === "c3")).toHaveLength(1);
    expect(reads.filter((id) => id === "c2")).toHaveLength(1);
  });

  test("a step read older than a step list that says otherwise is read again", async () => {
    const { backend, held } = runServer();
    render(viewer(backend, "c2"));
    await ui.findByText("os-c2");
    await waitFor(() => expect(stepReads(backend)).toContain("c3"));
    await act(async () => {});
    const readsOfC2 = () => stepReads(backend).filter((id) => id === "c2");

    // The list read again, saying the same: the step's read stands.
    await act(async () => {
      await utils!.runs.listCheckpoints.invalidate({ runId: RUN });
    });
    expect(readsOfC2()).toHaveLength(1);
    expect(ui.queryByTestId("decision-chip")).toBeNull();

    // Another reviewer approves c2. The list, read again, says so first;
    // the step's own read, still fresh, is read again and shows who did it.
    held.decided.add("c2");
    await act(async () => {
      await utils!.runs.listCheckpoints.invalidate({ runId: RUN });
    });
    await waitFor(() => expect(readsOfC2()).toHaveLength(2));
    const chip = await ui.findByTestId("decision-chip");
    expect(chip.textContent).toContain("Grace");
  });
});
