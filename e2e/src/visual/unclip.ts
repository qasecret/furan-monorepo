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

const UNCLIP_CSS = `
html, body { height: auto !important; overflow: visible !important; }
${SHELL_ROOT} { height: auto !important; min-height: 100vh; overflow: visible !important; }
${SHELL_ROOT} > div:has(> main), ${SHELL_ROOT} > div > main { overflow: visible !important; }
[data-testid="page-scroll"] { overflow: visible !important; }
${PUBLIC_ROOT} { height: auto !important; min-height: 100dvh; overflow: visible !important; }
.reveal-on .reveal { opacity: 1 !important; transform: none !important; }
`;

/**
 * Inject the un-clip sheet into the current document (it lasts until the next
 * navigation). Fails if the page has neither scroll root: the dashboard's
 * layout changed and this file must follow it, or the sweep silently goes
 * back to capturing one screen.
 */
export async function unclip(p: Page): Promise<void> {
  const roots = await p.locator(`${SHELL_ROOT}, ${PUBLIC_ROOT}`).count();
  if (roots === 0) {
    throw new Error(
      `unclip: no ${SHELL_ROOT} or ${PUBLIC_ROOT} scroll root on ${p.url()} — update e2e/src/visual/unclip.ts to the dashboard's layout`,
    );
  }
  await p.addStyleTag({ content: UNCLIP_CSS });
}
