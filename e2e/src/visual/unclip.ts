import type { Page } from "@playwright/test";

/**
 * The dashboard never scrolls the document: `html, body` are
 * `height: 100%; overflow: hidden` (apps/dashboard/src/app/globals.css) and
 * every surface scrolls inside its own container, so a `fullPage` screenshot
 * and axe only ever see the first 900px. This sheet lets each of those
 * containers grow to its content, so the DOCUMENT scrolls instead:
 *
 *  - app shell (app/(protected)/_components/app-shell.tsx): an
 *    `h-screen overflow-hidden` root, a column, and a clipping `<main>`; the
 *    centred pages scroll in PageContainer's `page-scroll`
 *    (components/ui/page-container.tsx). Full-bleed pages' own `flex-1`
 *    panels grow with the shell once nothing above them is bounded.
 *  - public pages (components/landing/landing-page.tsx,
 *    app/(public)/login/page.tsx): an `h-dvh overflow-y-auto` root.
 *  - the landing's scroll-reveal sections stay hidden until they enter the
 *    viewport, which below the first screen they never would here.
 *
 * Sweep-only: the app itself is never changed for this.
 */
const SHELL_ROOT = ".h-screen.overflow-hidden";
const PUBLIC_ROOT = ".h-dvh.overflow-y-auto";
const PAGE_SCROLL = '[data-testid="page-scroll"]';

const UNCLIP_CSS = `
html, body { height: auto !important; overflow: visible !important; }
${SHELL_ROOT} { height: auto !important; min-height: 100vh; overflow: visible !important; }
${SHELL_ROOT} > div:has(> main), ${SHELL_ROOT} > div > main { overflow: visible !important; }
${PAGE_SCROLL} { overflow: visible !important; }
${PUBLIC_ROOT} { height: auto !important; min-height: 100dvh; overflow: visible !important; }
.reveal-on .reveal { opacity: 1 !important; transform: none !important; }
`;

/**
 * Every box that still clips the page after the sheet, described for an error
 * message; empty when the whole page reaches the document. A string, because
 * the e2e tsconfig has no DOM lib. Three checks, so that a partial rename in
 * the dashboard's layout can't silently shrink the shot back to one screen:
 *
 *  1. `page-scroll`, when present, computes `overflow-y: visible`.
 *  2. Nothing between the document and a scroll root, `<main>` or
 *     `page-scroll` (inclusive) clips vertically: a box clips when its
 *     `overflow-y` isn't `visible` and its content is taller than it is.
 *  3. Inside `<main>`, no page-sized box (at least half the viewport tall and
 *     half of `<main>` wide) still scrolls its content: a scroll region the
 *     sheet no longer reaches, e.g. a renamed `page-scroll`.
 */
const STILL_CLIPPING = `(() => {
  const describe = (el) => {
    const id = el.id ? "#" + el.id : "";
    const testid = el.getAttribute("data-testid");
    const cls = typeof el.className === "string" && el.className.trim()
      ? "." + el.className.trim().split(/\\s+/).join(".")
      : "";
    return el.tagName.toLowerCase() + id + (testid ? '[data-testid="' + testid + '"]' : "") + cls;
  };
  const clips = (el) =>
    getComputedStyle(el).overflowY !== "visible" &&
    el.scrollHeight > el.clientHeight + 1;
  const found = new Map();
  for (const el of document.querySelectorAll(${JSON.stringify(PAGE_SCROLL)})) {
    const oy = getComputedStyle(el).overflowY;
    if (oy !== "visible") found.set(el, describe(el) + " has overflow-y: " + oy);
  }
  const seeds = document.querySelectorAll(${JSON.stringify(`main, ${PAGE_SCROLL}, ${SHELL_ROOT}, ${PUBLIC_ROOT}`)});
  for (const seed of seeds) {
    for (let el = seed; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      if (!found.has(el) && clips(el)) {
        found.set(el, describe(el) + " clips " + el.scrollHeight + "px of content to " + el.clientHeight + "px");
      }
    }
  }
  for (const main of document.querySelectorAll("main")) {
    for (const el of main.querySelectorAll("*")) {
      const oy = getComputedStyle(el).overflowY;
      if (
        !found.has(el) &&
        (oy === "auto" || oy === "scroll") &&
        el.clientHeight >= innerHeight / 2 &&
        el.clientWidth >= main.clientWidth / 2 &&
        el.scrollHeight > el.clientHeight + 1
      ) {
        found.set(el, describe(el) + " scrolls " + el.scrollHeight + "px of content in " + el.clientHeight + "px");
      }
    }
  }
  return [...found.values()];
})()`;

/**
 * Inject the un-clip sheet into the current document (it lasts until the next
 * navigation), then check it took. Fails if the page has neither scroll root,
 * or if any part of the page is still clipped afterwards (see
 * {@link STILL_CLIPPING}): either way the dashboard's layout changed and this
 * file must follow it, or the sweep silently goes back to capturing — and
 * contrast-checking — only the first screen.
 */
export async function unclip(p: Page): Promise<void> {
  const roots = await p.locator(`${SHELL_ROOT}, ${PUBLIC_ROOT}`).count();
  if (roots === 0) {
    throw new Error(
      `unclip: no ${SHELL_ROOT} or ${PUBLIC_ROOT} scroll root on ${p.url()} — update e2e/src/visual/unclip.ts to the dashboard's layout`,
    );
  }
  await p.addStyleTag({ content: UNCLIP_CSS });
  const clipping = (await p.evaluate(STILL_CLIPPING)) as string[];
  if (clipping.length > 0) {
    throw new Error(
      `unclip: ${p.url()} is still clipped after the un-clip sheet — update e2e/src/visual/unclip.ts to the dashboard's layout:\n  ${clipping.join("\n  ")}`,
    );
  }
}
