"use client";

import {
  History,
  Info,
  MessageSquare,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";

import {
  chooseRailTab,
  focusInRail,
  isNarrowWindow,
  openRailOn,
  RAIL_STRIP_WIDTH,
  railMaxWidth,
  setRailCollapsed,
  startRailVisit,
  useRailCollapsed,
  useRailState,
  useWindowWidth,
} from "./rail-state";
import { RailResizer } from "./RailResizer";
import { useViewerStore, type IgnoreEditMode } from "./useViewerStore";
import { useViewerPrefs, type RailTab } from "./viewer-prefs";

import { cn } from "@/lib/cn";
import { useCommandKeys } from "@/lib/commands/registry";

/** The rail's toggle command, whose keys the two buttons show. */
const TOGGLE = "viewer.rail.toggle";

/** The copy, verbatim from spec §8 (R26). */
const HIDE = "Hide details";
const SHOW = "Show details";
const DETAILS = "Details";
const IGNORE_REGIONS = "Ignore regions";
/** The editor's strip button: "Ignore regions (‹N›)". */
const ignoreRegions = (count: number) => `${IGNORE_REGIONS} (${count})`;

/** The collapsed strip's tabs, in the rail's order. */
const STRIP_TABS: { tab: RailTab; label: string; Icon: typeof Info }[] = [
  { tab: "info", label: "Info", Icon: Info },
  { tab: "history", label: "History", Icon: History },
  { tab: "comments", label: "Comments", Icon: MessageSquare },
];

/** The ignore-region editor is open. */
const editorIsOpen = (s: { ignoreEditMode: IgnoreEditMode }) =>
  s.ignoreEditMode !== "off";

/**
 * An icon button of the rail's chrome. The ring is inset: the viewer body is
 * overflow-hidden and would clip an outset one.
 */
const ICON_BUTTON =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-hover hover:text-fg focus-ring focus-visible:-outline-offset-2";

/**
 * What the open rail hands its content: the ref "Hide details" takes (the
 * button the rail moves focus to), and the id of the heading that names the
 * rail in the editor ("Ignore regions").
 */
interface RailSlots {
  hideRef: RefObject<HTMLButtonElement | null>;
  headingId: string;
}
const RailContext = createContext<RailSlots | null>(null);

/**
 * The id for the editor's "Ignore regions" heading: the rail's, which names
 * the rail by it (`aria-labelledby`), or one of its own outside a rail.
 */
export function useRailHeadingId(): string {
  const own = useId();
  return useContext(RailContext)?.headingId ?? own;
}

/**
 * "Hide details" (spec §5), for the open rail's content to place at the end
 * of its own header row (the details' tab row, the editor's heading), so the
 * rail spends no row of its own on one icon (Task 13 M10). Outside a rail it
 * renders nothing.
 */
export function RailHideButton({ className }: { className?: string }) {
  const rail = useContext(RailContext);
  const keys = useCommandKeys(TOGGLE);
  if (rail === null) return null;
  return (
    <button
      ref={rail.hideRef}
      type="button"
      aria-label={HIDE}
      aria-keyshortcuts={keys.ariaKeyShortcuts}
      title={`${HIDE}${keys.titleSuffix}`}
      onClick={() => setRailCollapsed(true, { moveFocus: true })}
      className={cn(ICON_BUTTON, className)}
    >
      <PanelRightClose className="h-4 w-4" aria-hidden />
    </button>
  );
}

interface Props {
  /**
   * What the open rail holds (the step's details, `TestInfoSidebar`), with a
   * `RailHideButton` at the end of its header row.
   */
  children: ReactNode;
  /**
   * What it holds instead while the ignore-region editor is open: the
   * editor's regions under "Ignore regions" (`IgnoreRegionListPanel`, with
   * its own `RailHideButton` and the rail's heading id), and how many there
   * are, for the collapsed strip. Absent: the editor leaves the rail alone.
   */
  editor?: { content: ReactNode; count: number };
  /** Told the tab the rail opened on, from its strip or a comment request. */
  onTab?: (tab: RailTab) => void;
}

/**
 * The diff viewer's info rail (spec §5): the shell around the step's details.
 *
 * - **Width.** The stored `railWidth`, shown up to the window's cap (560, and
 *   never over 45% of the window): a narrower window, or a browser zoom,
 *   clamps what is shown and never what is stored (Review Focus 5). The
 *   separator on its left edge resizes it (`RailResizer`).
 * - **Collapsed**, it is a 40 px strip: "Show details", then Info, History
 *   and Comments, each opening the rail on its tab. "Hide details" (which
 *   the content places, `RailHideButton`), `t` (`viewer.rail.toggle`) and
 *   the strip toggle it. Focus stays on the button pressed; when that button
 *   goes, it moves to its counterpart ("Show details" / "Hide details").
 * - **Below 1024 px** it starts collapsed for the visit, unstored, and
 *   opened it lies over the canvas's right edge (with the overlay shadow)
 *   instead of narrowing it, while the strip's 40 px stay taken, so the
 *   canvas doesn't widen either (Task 13 M3); Esc (`viewer.escape`) or `t`
 *   closes it.
 * - **Comments.** A request for the comments (`c`, Mark as Bug: the viewer
 *   store's `commentPanelOpen`) opens it on Comments, and is taken.
 * - **Edit mode.** While the ignore-region editor is open the rail holds
 *   the editor's regions (`editor`) in place of its content, one rail and
 *   never two columns. Collapsed, its strip is one button, "Ignore regions
 *   (‹N›)" with the count, which opens it (R26); the details' tabs would
 *   open on what the editor hides. The tab is never changed by editing, so
 *   leaving the editor brings back the one the reviewer was on. Focus in
 *   what the swap takes away moves to the rail's toggle, which stays
 *   ("Hide details", or the strip's button).
 * - **Its name.** The landmark is "Details"; in the editor, its "Ignore
 *   regions" heading names it (collapsed, where no heading is, the same
 *   words do).
 *
 * The width, the collapsed state and the tab are the user's preferences
 * (`useViewerPrefs`); the tab is the content's to show (`prefs.railTab`).
 */
export function InfoRail({ children, editor, onTab }: Props) {
  // The visit starts with the first rail: collapsed below 1024 px. Read
  // before the state below, so the first paint is already collapsed there.
  startRailVisit();
  const collapsed = useRailCollapsed();
  const storedWidth = useViewerPrefs((s) => s.prefs.railWidth);
  const windowWidth = useWindowWidth();
  const cap = railMaxWidth(windowWidth);
  const width = Math.min(storedWidth, cap);
  const overlaid = !collapsed && isNarrowWindow(windowWidth);
  const editorOpen = useViewerStore(editorIsOpen);
  const editing = editorOpen && editor != null;
  const focusMove = useRailState((s) => s.focus);
  const keys = useCommandKeys(TOGGLE);
  const hideRef = useRef<HTMLButtonElement>(null);
  const showRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  const slots = useMemo(() => ({ hideRef, headingId }), [headingId]);

  // On screen: the rail's keys act (`viewer.rail.toggle`, Esc's close).
  useEffect(() => {
    useRailState.setState((s) => ({ mounted: s.mounted + 1 }));
    return () =>
      useRailState.setState((s) => ({
        mounted: s.mounted - 1,
        // A focus move owed to this rail goes with it.
        focus: s.mounted > 1 ? s.focus : null,
      }));
  }, []);

  // The focus move a toggle owes, once the counterpart is on screen.
  useLayoutEffect(() => {
    if (focusMove === null) return;
    const target = focusMove === "show" ? showRef.current : hideRef.current;
    if (!target) return;
    target.focus();
    useRailState.setState({ focus: null });
  }, [focusMove, collapsed]);

  // Opening or closing the editor swaps what the rail holds, and the strip's
  // tabs: focus in what went moves to the toggle that stays. Whether focus
  // was in the rail is read as the editor changes, before the swap, and is
  // settled in the commit that follows (with no `editor`, nothing went).
  const focusWasIn = useRef(false);
  useEffect(
    () =>
      useViewerStore.subscribe((now, before) => {
        if (editorIsOpen(now) !== editorIsOpen(before))
          focusWasIn.current = focusInRail();
      }),
    [],
  );
  useLayoutEffect(() => {
    if (!focusWasIn.current) return;
    focusWasIn.current = false;
    // Focus still on something (what stays, the separator): left alone.
    const focused = document.activeElement;
    if (focused !== null && focused !== document.body) return;
    (collapsed ? showRef : hideRef).current?.focus();
  }, [editorOpen, collapsed]);

  const openOn = useCallback(
    (tab: RailTab, moveFocus?: boolean) => {
      openRailOn(tab, moveFocus === undefined ? {} : { moveFocus });
      onTab?.(tab);
    },
    [onTab],
  );

  // A request for the comments: open on Comments, and take the request. In
  // the editor the rail shows the editor's regions, not the comments: the
  // request only makes Comments the tab that comes back, and opens nothing
  // (Mark as Bug; `c` is off there).
  const commentRequested = useViewerStore((s) => s.commentPanelOpen);
  useLayoutEffect(() => {
    if (!commentRequested) return;
    useViewerStore.getState().setCommentPanelOpen(false);
    if (editing) chooseRailTab("comments");
    else openOn("comments");
  }, [commentRequested, editing, openOn]);

  // The window's cap: what is stored is kept when the window is what stops
  // it, and it already reaches that cap, so a narrow window never takes the
  // stored width down to its own (Review Focus 5). Only a commit stores.
  const onResize = useCallback((asked: number, commit: boolean) => {
    const { prefs, set } = useViewerPrefs.getState();
    const limit = railMaxWidth(window.innerWidth);
    const next =
      asked >= limit && prefs.railWidth >= limit ? prefs.railWidth : asked;
    if (!commit && next === prefs.railWidth) return;
    set("railWidth", next, { persist: commit });
  }, []);

  if (collapsed) {
    return (
      <aside
        // Focus in it is the rail's (`focusInRail`).
        data-info-rail=""
        data-collapsed=""
        data-testid="test-info-sidebar"
        aria-label={editing ? IGNORE_REGIONS : DETAILS}
        style={{ width: RAIL_STRIP_WIDTH }}
        className="flex shrink-0 flex-col items-center gap-1 border-l border-edge bg-canvas py-1"
      >
        {/* One element either way, so focus on it survives the editor. */}
        <button
          ref={showRef}
          type="button"
          aria-label={editing ? ignoreRegions(editor.count) : SHOW}
          aria-keyshortcuts={keys.ariaKeyShortcuts}
          title={`${editing ? ignoreRegions(editor.count) : SHOW}${keys.titleSuffix}`}
          onClick={() => setRailCollapsed(false, { moveFocus: true })}
          className={cn(
            ICON_BUTTON,
            // In the editor: its icon over the count.
            editing && "h-auto flex-col gap-0.5 py-1.5",
          )}
        >
          {editing ? (
            <>
              <Pencil className="h-4 w-4" aria-hidden />
              <span className="text-2xs font-medium tabular-nums" aria-hidden>
                {editor.count}
              </span>
            </>
          ) : (
            <PanelRightOpen className="h-4 w-4" aria-hidden />
          )}
        </button>
        {!editing && (
          <>
            <span className="my-1 h-px w-6 bg-edge" aria-hidden />
            {STRIP_TABS.map(({ tab, label, Icon }) => (
              <button
                key={tab}
                type="button"
                aria-label={label}
                title={label}
                onClick={() => openOn(tab, true)}
                data-testid={`rail-strip-${tab}`}
                className={ICON_BUTTON}
              >
                <Icon className="h-4 w-4" aria-hidden />
              </button>
            ))}
          </>
        )}
      </aside>
    );
  }

  return (
    <>
      {overlaid && (
        // The strip's place, still taken while the rail lies over the
        // canvas: opening it there changes the canvas's width not at all,
        // neither narrowing it nor widening it by the strip's 40 px (Task 13
        // M3). Before the rail, so the rail itself is not remounted when the
        // window crosses 1024 px.
        <div
          aria-hidden
          data-rail-spacer=""
          style={{ width: RAIL_STRIP_WIDTH }}
          className="shrink-0"
        />
      )}
      <aside
        data-info-rail=""
        data-rail-overlay={overlaid ? "" : undefined}
        data-testid="test-info-sidebar"
        // Named "Details", or in the editor by its "Ignore regions" heading.
        aria-label={editing ? undefined : DETAILS}
        aria-labelledby={editing ? headingId : undefined}
        style={{ width }}
        className={cn(
          "flex shrink-0 flex-col border-l border-edge bg-canvas",
          // Below 1024 px it lies over the canvas's right edge instead of
          // narrowing it.
          overlaid
            ? "absolute inset-y-0 right-0 z-30 shadow-overlay"
            : "relative",
        )}
      >
        <RailResizer width={width} onResize={onResize} />
        <RailContext.Provider value={slots}>
          <div className="flex min-h-0 flex-1 flex-col">
            {editing ? editor.content : children}
          </div>
        </RailContext.Provider>
      </aside>
    </>
  );
}
