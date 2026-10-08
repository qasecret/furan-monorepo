/**
 * Shared jsdom shims for component tests.
 *
 * T9: Radix Slider depends on `ResizeObserver` and pointer-capture APIs
 * that jsdom does not implement. Stubbing them at module-init is cheaper
 * than mocking the slider primitive itself.
 */
import { afterEach } from "vitest";

// Radix overlays (Dialog / DropdownMenu / Popover / Select) lock the page by
// setting `pointer-events: none` on <body> while open, restoring it on close
// via a React effect cleanup. When a test unmounts an *open* overlay that
// restore can be skipped, leaving <body> inert. Because the suite runs in a
// single fork (see vitest.config), the leaked style then makes
// @testing-library/user-event refuse the NEXT test's clicks with "element has
// pointer-events: none" (the check walks up to <body>). Reset it after every
// test so an overlay test can't poison unrelated ones.
afterEach(() => {
  // Guarded: `// @vitest-environment node` suites (token CSS tests) have no DOM.
  if (typeof document !== "undefined") document.body.style.pointerEvents = "";
});

class ResizeObserverStub implements ResizeObserver {
  observe(): void {
    /* noop */
  }
  unobserve(): void {
    /* noop */
  }
  disconnect(): void {
    /* noop */
  }
}

type GlobalWithObs = typeof globalThis & {
  ResizeObserver: typeof ResizeObserver;
};
const g = globalThis as GlobalWithObs;
if (typeof g.ResizeObserver === "undefined") {
  g.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

// Radix calls these on the slider thumb; jsdom HTMLElement lacks them.
const proto = globalThis.HTMLElement?.prototype as
  | (HTMLElement & {
      hasPointerCapture?: () => boolean;
      setPointerCapture?: () => void;
      releasePointerCapture?: () => void;
    })
  | undefined;
if (proto) {
  if (typeof proto.hasPointerCapture !== "function") {
    proto.hasPointerCapture = () => false;
  }
  if (typeof proto.setPointerCapture !== "function") {
    proto.setPointerCapture = () => undefined;
  }
  if (typeof proto.releasePointerCapture !== "function") {
    proto.releasePointerCapture = () => undefined;
  }
}

// Radix Select (Task 3 / Task 9) calls scrollIntoView when opening the popover;
// jsdom Element does not implement it. Defensive shim so future tests don't
// break when they mount a <Select> for the first time.
const elemProto = globalThis.Element?.prototype as
  | (Element & { scrollIntoView?: () => void })
  | undefined;
if (elemProto && typeof elemProto.scrollIntoView !== "function") {
  elemProto.scrollIntoView = () => undefined;
}
