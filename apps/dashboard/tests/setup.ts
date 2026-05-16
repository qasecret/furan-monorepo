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
