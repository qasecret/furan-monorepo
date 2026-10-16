import {
  isCharacterBinding,
  isNonTypingBinding,
  type BindingOptions,
} from "./keys";

/**
 * The one guard every key goes through (spec §3.4): it says when a keystroke
 * belongs to something other than a command, so a shortcut yields to it.
 */

// <input> types that take no typed text: single-key shortcuts still apply
// while one of these has focus (e.g. after clicking a checkbox).
export const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/**
 * Widgets that consume bare keys themselves: menu / listbox typeahead
 * (pressing "A" in the open More menu jumps to "Approve all"), and dialogs
 * layered over the page. Radix portals included: the role sits on the
 * portal's own content, which holds the focus.
 */
export const KEYBOARD_OWNER_ROLES =
  '[role="menu"],[role="menubar"],[role="listbox"],[role="dialog"],[role="alertdialog"]';

/**
 * A non-modal dialog: inline in the page, no focus trap, nothing laid over
 * it. It owns the page's keys while focus is in it, but the app's own keys,
 * the global commands' (`passesNonModal`), pass it: ⌘K, `?`, `/`, `g …` and
 * ⌘Z (R33). The one today is the review loop's done card (BatchDoneCard),
 * where every review loop ends, and where undoing the decision that brought
 * it up brings the step back (R20).
 */
export const NON_MODAL = "[data-non-modal]";

/**
 * The element `useListCursor`'s `itemProps` marks as a list item. Enter on it
 * is the command's (it opens the row), even when the item is itself a link or
 * a button.
 */
export const LIST_ITEM = "[data-cursor-id]";

/** What Enter or Space activates natively when it has focus. */
const NATIVE_CONTROLS =
  'button,a[href],summary,input,select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"]';

/**
 * A control that types ahead on letters without being a text field: a closed
 * Radix Select's trigger is a `button[role=combobox]`.
 */
const TYPEAHEAD_CONTROLS = '[role="combobox"]';

const ACTIVATION_KEYS = new Set(["Enter", "Space", " "]);

/** True when focus is in a field that takes typed text. */
export function isTypingInInput(): boolean {
  if (typeof document === "undefined") return false;
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.tagName === "INPUT") {
    return !NON_TEXT_INPUT_TYPES.has((el as HTMLInputElement).type);
  }
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  // `closest` also covers focus inside a nested editable region (and jsdom,
  // which doesn't implement `isContentEditable`).
  if (
    el.isContentEditable ||
    el.closest('[contenteditable]:not([contenteditable="false"])')
  ) {
    return true;
  }
  return false;
}

/**
 * True when this keystroke belongs to something else, so the command bound
 * to `key` must not run. Every binding of every command is checked here, in
 * one place, so a new shortcut can't forget to yield. `key` is the binding
 * that matched ("a", "$mod+k", "g i") and `opts` its effective options
 * (`bindingOptions`). In order:
 *
 * 1. another handler already took it (`defaultPrevented`);
 * 2. an IME composition is under way;
 * 3. focus is in a text field, a select or an editable region, or (for a
 *    character key) on a combobox, which types ahead. Typing "a" in the
 *    PatternEditor must not approve the run, "/" must not open the palette
 *    mid-regex. Two exceptions, both only for a binding that cannot type or
 *    edit (`isNonTypingBinding`: ⌘ / Ctrl / Alt chords, Esc): a field inside
 *    the dialog `allowInDialog` names (⌘K closes the palette from its own
 *    search box, while "r" typed there stays typing), and any page field
 *    when the binding sets `allowInText` (⌘K opens the palette from the
 *    Batches search box; ⌘Z does not set it, so it stays the field's undo);
 * 4. focus is inside a menu, listbox or dialog, unless it is the dialog
 *    `allowInDialog` names, or a non-modal one (`[data-non-modal]`, the done
 *    card) and the binding is a global command's (`passesNonModal`): the
 *    app's keys (⌘K, `?`, `/`, `g …`, ⌘Z) pass it, while every page, list
 *    and decision key (`a`, `j`, the arrows, Enter, Esc…) stays its own
 *    (R33). The dispatcher records a sequence's prefix ("g") the same way;
 * 5. the key is auto-repeating and the binding does not repeat;
 * 6. single-key shortcuts are off and `key` is a character binding (a
 *    character key, or a sequence of them; arrows, Enter, Esc and anything
 *    with ⌘ / Ctrl / Alt keep working);
 * 7. the key is Enter or Space (as the binding, or as the key the event
 *    carries, so `Shift+Enter` counts) and focus is on a control that
 *    activates on it (button, link, summary, form control), other than the
 *    list item itself: native activation wins;
 * 8. the binding is tied to an element (`focusWithin`) and focus is outside.
 *
 * Focus is read from `document.activeElement`: a key press goes to the
 * focused element, and the dispatcher listens on `window`.
 */
export function keyIsOwnedElsewhere(
  e: KeyboardEvent,
  key: string,
  opts: BindingOptions,
  prefs: { singleKeys: boolean },
): boolean {
  if (e.defaultPrevented) return true; // 1
  if (e.isComposing || e.keyCode === 229) return true; // 2

  const focus =
    typeof document === "undefined"
      ? null
      : (document.activeElement as HTMLElement | null);
  const owner = focus?.closest(KEYBOARD_OWNER_ROLES) ?? null;
  const inAllowedDialog =
    owner !== null &&
    opts.allowInDialog !== undefined &&
    owner.matches(opts.allowInDialog);

  // The dialog a command names, or `allowInText`, lets only a non-typing
  // binding past a text field: anything else typed there is typing.
  const waived =
    (inAllowedDialog || opts.allowInText === true) && isNonTypingBinding(key);
  if (!waived) {
    if (isTypingInInput()) return true; // 3
    if (focus?.matches(TYPEAHEAD_CONTROLS) && isCharacterBinding(key)) {
      return true; // 3
    }
  }
  if (
    owner !== null &&
    !inAllowedDialog &&
    !(opts.passesNonModal === true && owner.matches(NON_MODAL))
  ) {
    return true; // 4
  }
  if (e.repeat && !opts.repeat) return true; // 5
  if (!prefs.singleKeys && isCharacterBinding(key)) return true; // 6
  if (
    (ACTIVATION_KEYS.has(key) || e.key === "Enter" || e.key === " ") &&
    focus?.matches(NATIVE_CONTROLS) &&
    !focus.matches(LIST_ITEM)
  ) {
    return true; // 7
  }
  if (opts.focusWithin !== undefined) {
    if (!focus?.closest(opts.focusWithin)) return true; // 8
  }
  return false;
}
