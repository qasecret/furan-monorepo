/**
 * Shared jsdom shims for component tests.
 *
 * T9: Radix Slider depends on `ResizeObserver` and pointer-capture APIs
 * that jsdom does not implement. Stubbing them at module-init is cheaper
 * than mocking the slider primitive itself.
 */

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
