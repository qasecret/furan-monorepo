import { afterEach, describe, expect, it, vi } from "vitest";

import { keyIsOwnedElsewhere } from "@/lib/commands/guard";
import { bindingOptions } from "@/lib/commands/keys";
import type { Command } from "@/lib/commands/types";

type Opts = Parameters<typeof keyIsOwnedElsewhere>[2];
type Prefs = Parameters<typeof keyIsOwnedElsewhere>[3];

const ON: Prefs = { singleKeys: true };
const OFF: Prefs = { singleKeys: false };

/** The last keystroke of `key` as the browser reports it ("g i" ends in "i"). */
function keystroke(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key: key.split(" ").pop() ?? key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
}

/** Asks the guard about one press, with the focus wherever the test put it. */
function owned(
  key: string,
  opts: Opts = {},
  prefs: Prefs = ON,
  init: KeyboardEventInit = {},
): boolean {
  return keyIsOwnedElsewhere(keystroke(key, init), key, opts, prefs);
}

function page(html: string) {
  document.body.innerHTML = html;
}

function focus(selector: string) {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`no element for ${selector}`);
  el.focus();
  expect(document.activeElement, selector).toBe(el);
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("keyIsOwnedElsewhere", () => {
  it("is false for a plain key with nothing focused", () => {
    expect(owned("a")).toBe(false);
    expect(owned("$mod+k")).toBe(false);
    expect(owned("Escape")).toBe(false);
  });

  it("defaultPrevented", () => {
    const e = keystroke("a");
    expect(keyIsOwnedElsewhere(e, "a", {}, ON)).toBe(false);
    e.preventDefault();
    expect(e.defaultPrevented).toBe(true);
    expect(keyIsOwnedElsewhere(e, "a", {}, ON)).toBe(true);
  });

  it("IME composition (isComposing / keyCode 229)", () => {
    expect(owned("a", {}, ON, { isComposing: true })).toBe(true);
    expect(owned("a", {}, ON, { keyCode: 229 })).toBe(true);
    expect(owned("Enter", {}, ON, { isComposing: true })).toBe(true);
    // Ordinary key codes are not composition.
    expect(owned("a", {}, ON, { keyCode: 65 })).toBe(false);
  });

  it("text input, textarea, select, contenteditable own the key", () => {
    const cases: Array<[string, string]> = [
      ["input with no type", `<input id="t" />`],
      ["input type=text", `<input id="t" type="text" />`],
      ["input type=search", `<input id="t" type="search" />`],
      ["input type=email", `<input id="t" type="email" />`],
      ["input type=number", `<input id="t" type="number" />`],
      ["textarea", `<textarea id="t"></textarea>`],
      ["select", `<select id="t"><option>x</option></select>`],
      [
        "contenteditable",
        `<div id="t" contenteditable="true" tabindex="0">x</div>`,
      ],
      [
        "a node inside a contenteditable region",
        `<div contenteditable="true"><span id="t" tabindex="-1">x</span></div>`,
      ],
    ];
    for (const [name, html] of cases) {
      page(html);
      focus("#t");
      expect(owned("a"), name).toBe(true);
      expect(owned("ArrowDown"), name).toBe(true);
    }

    // The same markup with focus elsewhere does not own the key.
    page(`<input id="t" /><button id="b">x</button>`);
    focus("#b");
    expect(owned("a")).toBe(false);

    // contenteditable="false" is not an editor.
    page(`<div id="t" contenteditable="false" tabindex="0">x</div>`);
    focus("#t");
    expect(owned("a")).toBe(false);
  });

  it("a checkbox does not", () => {
    for (const html of [
      `<input id="t" type="checkbox" />`,
      `<input id="t" type="radio" />`,
      `<input id="t" type="button" value="x" />`,
      `<input id="t" type="submit" value="x" />`,
      `<input id="t" type="range" />`,
      `<button id="t">x</button>`,
    ]) {
      page(html);
      focus("#t");
      expect(owned("a"), html).toBe(false);
    }
  });

  it("each of menu, menubar, listbox, dialog, alertdialog owns the key", () => {
    for (const role of [
      "menu",
      "menubar",
      "listbox",
      "dialog",
      "alertdialog",
    ]) {
      page(
        `<div role="${role}"><div tabindex="0" id="t">x</div></div><button id="b">x</button>`,
      );
      focus("#t");
      expect(owned("a"), role).toBe(true);
      expect(owned("Escape"), role).toBe(true);
      focus("#b");
      expect(owned("a"), `outside ${role}`).toBe(false);
    }

    // A role set deeper than the focused node still owns it (a Radix
    // portal's content sits under body, with the role on an ancestor).
    page(
      `<div role="dialog"><div><div><button id="t">x</button></div></div></div>`,
    );
    focus("#t");
    expect(owned("r")).toBe(true);
  });

  it("allowInDialog matches only its own dialog", () => {
    page(
      `<div role="dialog" data-done-card><button id="card">Continue</button></div>` +
        `<div role="dialog" id="other"><button id="elsewhere">x</button></div>`,
    );
    const esc: Opts = { allowInDialog: "[data-done-card]" };

    focus("#card");
    expect(owned("Escape", esc)).toBe(false);
    // Without the option the dialog owns Esc.
    expect(owned("Escape")).toBe(true);

    focus("#elsewhere");
    expect(owned("Escape", esc)).toBe(true);

    // A listbox opened inside the allowed dialog is a different owner: it
    // keeps Esc (to close itself).
    page(
      `<div role="dialog" data-done-card><div role="listbox"><div id="opt" tabindex="0">x</div></div></div>`,
    );
    focus("#opt");
    expect(owned("Escape", esc)).toBe(true);
  });

  it("a text field inside the allowed dialog does not own the key", () => {
    // ⌘K inside the open palette closes it, with the focus in its search
    // input: the one text field that must not swallow the key.
    page(
      `<div role="dialog" data-command-palette><input id="search" /></div>` +
        `<div role="dialog"><input id="other" /></div>` +
        `<input id="page" />`,
    );
    const toggle: Opts = { allowInDialog: "[data-command-palette]" };

    focus("#search");
    expect(owned("$mod+k", toggle)).toBe(false);
    // Any other key typed there is still typing.
    expect(owned("a")).toBe(true);
    expect(owned("$mod+k")).toBe(true);

    // Another dialog's field, or a field on the page, still owns it.
    focus("#other");
    expect(owned("$mod+k", toggle)).toBe(true);
    focus("#page");
    expect(owned("$mod+k", toggle)).toBe(true);
  });

  it("in the allowed dialog's text field, r / Backspace stay owned while $mod+k and Escape do not", () => {
    // The palette's search box: only keys that cannot type or edit text
    // may pass, or "r" would reject the step it is typed over.
    page(`<div role="dialog" data-command-palette><input id="search" /></div>`);
    focus("#search");
    const inPalette: Opts = { allowInDialog: "[data-command-palette]" };

    for (const key of [
      "r",
      "a",
      "/",
      "?",
      "Backspace",
      "Delete",
      "Enter",
      "Space",
      "ArrowDown",
      "Home",
      "g i",
      "Shift+?",
    ]) {
      expect(owned(key, inPalette), key).toBe(true);
    }
    for (const key of [
      "$mod+k",
      "Control+k",
      "Meta+k",
      "Alt+x",
      "Escape",
      "Shift+Escape",
    ]) {
      expect(owned(key, inPalette), key).toBe(false);
    }

    // A text field in a dialog the command did not name owns all of them.
    page(
      `<div role="dialog" data-command-palette><input id="search" /></div>` +
        `<div role="dialog" data-other><input id="other" /></div>`,
    );
    focus("#other");
    expect(owned("Escape", inPalette)).toBe(true);
    expect(owned("$mod+k", inPalette)).toBe(true);
  });

  it("a focused combobox owns character keys", () => {
    // A closed Radix Select's trigger types ahead on letters: "j" must not
    // also move the list cursor.
    for (const html of [
      `<button id="t" role="combobox" aria-expanded="false">All</button>`,
      `<div id="t" role="combobox" tabindex="0">All</div>`,
    ]) {
      page(html);
      focus("#t");
      for (const key of ["j", "k", "a", "r", "s", "?", "/", "g i"]) {
        expect(owned(key), `${html} ${key}`).toBe(true);
      }
      // Keys that are not characters keep their own handling.
      for (const key of ["ArrowDown", "ArrowUp", "Escape", "$mod+k", "Home"]) {
        expect(owned(key), `${html} ${key}`).toBe(false);
      }
    }

    // Inside the dialog a command names, a combobox still types ahead.
    page(
      `<div role="dialog" data-done-card><button id="t" role="combobox">All</button></div>`,
    );
    focus("#t");
    expect(owned("r", { allowInDialog: "[data-done-card]" })).toBe(true);
    expect(owned("Escape", { allowInDialog: "[data-done-card]" })).toBe(false);

    // Not a combobox: the letters are free.
    page(`<button id="t">All</button>`);
    focus("#t");
    expect(owned("j")).toBe(false);
  });

  it("allowInText never lets a letter fire from a text field", () => {
    page(
      `<input id="search" /><textarea id="reason"></textarea>` +
        `<div id="rich" contenteditable="true"></div>` +
        `<button id="sel" role="combobox">All</button>` +
        `<div role="dialog"><input id="dlg" /></div>`,
    );
    const inText: Opts = { allowInText: true };

    for (const id of ["#search", "#reason", "#rich"]) {
      focus(id);
      // ⌘K (and any ⌘ / Ctrl / Alt chord, or Esc) may fire from the field…
      for (const key of ["$mod+k", "Control+k", "Alt+x", "Escape"]) {
        expect(owned(key, inText), `${id} ${key}`).toBe(false);
      }
      // …but nothing that types or edits, whatever the binding asks.
      for (const key of [
        "a",
        "r",
        "/",
        "?",
        "Shift+?",
        "g i",
        "Backspace",
        "Delete",
        "Enter",
        "Space",
        "ArrowDown",
        "Home",
      ]) {
        expect(owned(key, inText), `${id} ${key}`).toBe(true);
      }
      // Without the option, a field owns ⌘K as well: ⌘Z stays text undo.
      expect(owned("$mod+k"), id).toBe(true);
      expect(owned("$mod+z"), id).toBe(true);
    }

    // A combobox still types ahead on letters.
    focus("#sel");
    expect(owned("j", inText)).toBe(true);

    // It is no way past a dialog: rule 4 still owns the key.
    focus("#dlg");
    expect(owned("$mod+k", inText)).toBe(true);

    // A per-key option overrides the command's own.
    const palette: Pick<Command, "allowInText"> = { allowInText: true };
    expect(bindingOptions(palette, "$mod+k")).toEqual({ allowInText: true });
    expect(
      bindingOptions(palette, { key: "$mod+k", allowInText: false }),
    ).toEqual({ allowInText: false });
    expect(bindingOptions({}, { key: "$mod+k", allowInText: true })).toEqual({
      allowInText: true,
    });
  });

  it("repeat is ignored unless the command allows it", () => {
    expect(owned("a", {}, ON, { repeat: true })).toBe(true);
    expect(owned("a", { repeat: false }, ON, { repeat: true })).toBe(true);
    expect(owned("a", { repeat: true }, ON, { repeat: true })).toBe(false);
    // A first press is never a repeat.
    expect(owned("a", {}, ON, { repeat: false })).toBe(false);
  });

  it("single-key switch off ignores character keys but not $mod+k, Escape, ArrowDown, Enter", () => {
    for (const key of ["a", "j", "?", "/", "[", "=", "0", "Shift++", "x"]) {
      expect(owned(key, {}, OFF), key).toBe(true);
      expect(owned(key, {}, ON), `${key} on`).toBe(false);
    }
    for (const key of [
      "$mod+k",
      "$mod+z",
      "Escape",
      "ArrowDown",
      "ArrowUp",
      "Enter",
      "Home",
      "End",
      "Delete",
      "Backspace",
      "Shift+ArrowDown",
    ]) {
      expect(owned(key, {}, OFF), key).toBe(false);
    }
  });

  it("switch off skips j but not ArrowDown on the same command", () => {
    const next: Command = {
      id: "list.next",
      label: "Next row",
      group: "Navigate",
      scope: "batches",
      keys: [
        "j",
        { key: "ArrowDown", focusWithin: "[data-list]", repeat: true },
      ],
      run: () => undefined,
    };
    page(`<ul data-list><li tabindex="0" id="row">x</li></ul>`);
    focus("#row");

    const [j, down] = next.keys ?? [];
    expect(j).toBeDefined();
    expect(down).toBeDefined();
    expect(owned("j", bindingOptions(next, j!), OFF)).toBe(true);
    expect(owned("ArrowDown", bindingOptions(next, down!), OFF)).toBe(false);
    // A held ArrowDown repeats; `j` on again is back to running.
    expect(
      owned("ArrowDown", bindingOptions(next, down!), OFF, { repeat: true }),
    ).toBe(false);
    expect(owned("j", bindingOptions(next, j!), ON)).toBe(false);
  });

  it("switch off skips the g i sequence", () => {
    // The matched key is the whole sequence; the event is its last press.
    expect(owned("g i", {}, OFF)).toBe(true);
    expect(owned("g a", {}, OFF)).toBe(true);
    expect(owned("g i", {}, ON)).toBe(false);
    // A sequence with a named step is not a character binding.
    expect(owned("g Enter", {}, OFF)).toBe(false);
  });

  it("Enter on a button or link is left to native activation; Enter on a focused list item is not", () => {
    const natives: Array<[string, string]> = [
      ["button", `<button id="t">x</button>`],
      ["link", `<a id="t" href="/x">x</a>`],
      ["summary", `<details><summary id="t">x</summary>y</details>`],
      ["checkbox", `<input id="t" type="checkbox" />`],
      ["submit input", `<input id="t" type="submit" value="x" />`],
      ["role=button", `<div id="t" role="button" tabindex="0">x</div>`],
      ["role=link", `<span id="t" role="link" tabindex="0">x</span>`],
      [
        "a button inside a list item",
        `<li data-cursor-id="a"><button id="t">x</button></li>`,
      ],
    ];
    for (const [name, html] of natives) {
      page(html);
      focus("#t");
      expect(owned("Enter"), name).toBe(true);
      expect(owned("Space"), `${name} (Space)`).toBe(true);
      expect(owned(" "), `${name} (" ")`).toBe(true);
      // Only the two activation keys are left to the control.
      expect(owned("a"), `${name} (a)`).toBe(false);
      expect(owned("ArrowDown"), `${name} (ArrowDown)`).toBe(false);
      expect(owned("Escape"), `${name} (Escape)`).toBe(false);
    }

    // The list item itself: the cursor's own element, even a link or a
    // button, is not left to native activation.
    const items: Array<[string, string]> = [
      [
        "tr",
        `<table><tbody><tr id="t" tabindex="0" data-cursor-id="a"><td>x</td></tr></tbody></table>`,
      ],
      ["li", `<ul><li id="t" tabindex="0" data-cursor-id="a">x</li></ul>`],
      ["link item", `<a id="t" href="/x" data-cursor-id="a">x</a>`],
      ["button item", `<button id="t" data-cursor-id="a">x</button>`],
    ];
    for (const [name, html] of items) {
      page(html);
      focus("#t");
      expect(owned("Enter"), name).toBe(false);
      expect(owned("Space"), `${name} (Space)`).toBe(false);
    }

    // A chord on the activation key: the control still activates on the
    // Enter / Space itself, so the binding string does not matter.
    page(`<button id="t">x</button>`);
    focus("#t");
    expect(owned("a", {}, ON, { key: "Enter" })).toBe(true);
    expect(owned("a", {}, ON, { key: " " })).toBe(true);

    // A focusable item that is not a control is never native.
    page(`<div id="t" role="listitem" tabindex="0">x</div>`);
    focus("#t");
    expect(owned("Enter")).toBe(false);
  });

  it("Shift+Enter on a focused button is left to native activation", () => {
    page(
      `<button id="t">x</button><li tabindex="0" data-cursor-id="a" id="item">x</li>`,
    );
    focus("#t");
    const press = (key: string, init: KeyboardEventInit) =>
      owned(key, {}, ON, init);
    expect(press("Shift+Enter", { key: "Enter", shiftKey: true })).toBe(true);
    expect(press("$mod+Enter", { key: "Enter", ctrlKey: true })).toBe(true);
    expect(press("Shift+Space", { key: " ", shiftKey: true })).toBe(true);
    // Another key on the button is not activation.
    expect(press("Shift+ArrowDown", { key: "ArrowDown", shiftKey: true })).toBe(
      false,
    );
    // The list item itself keeps its own Enter, chord or not.
    focus("#item");
    expect(press("Shift+Enter", { key: "Enter", shiftKey: true })).toBe(false);
  });

  it("focusWithin ignores the key outside the element", () => {
    page(
      `<ul data-list><li id="in" tabindex="0">x</li></ul><button id="out">x</button>`,
    );
    const inList: Opts = { focusWithin: "[data-list]" };

    focus("#in");
    expect(owned("ArrowDown", inList)).toBe(false);
    focus("#out");
    expect(owned("ArrowDown", inList)).toBe(true);
    // No element focused at all (body): outside the list.
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    expect(owned("ArrowDown", inList)).toBe(true);

    // The browser reports no focused element at all: outside, and no throw.
    vi.spyOn(document, "activeElement", "get").mockReturnValue(null);
    expect(owned("ArrowDown", inList)).toBe(true);
    expect(owned("ArrowDown")).toBe(false);
    vi.restoreAllMocks();

    // Without the option the key is not tied to the list.
    focus("#out");
    expect(owned("ArrowDown")).toBe(false);
  });

  it("passesUndo lets ⌘Z through a [data-passes-undo] dialog", () => {
    page(
      `<div role="dialog" data-passes-undo><button id="card">Continue</button></div>` +
        `<div role="dialog"><button id="plain">x</button></div>`,
    );
    const undo: Opts = { passesUndo: true };

    focus("#card");
    expect(owned("$mod+z", undo)).toBe(false);
    // Any other command stays out of that dialog.
    expect(owned("$mod+z")).toBe(true);
    expect(owned("a")).toBe(true);

    // A dialog without the attribute keeps ⌘Z too.
    focus("#plain");
    expect(owned("$mod+z", undo)).toBe(true);

    // Typing inside the dialog is still typing: native undo wins.
    page(`<div role="dialog" data-passes-undo><input id="field" /></div>`);
    focus("#field");
    expect(owned("$mod+z", undo)).toBe(true);

    // A menu opened inside it is its own owner.
    page(
      `<div role="dialog" data-passes-undo><div role="menu"><div id="item" tabindex="0">x</div></div></div>`,
    );
    focus("#item");
    expect(owned("$mod+z", undo)).toBe(true);
  });
});
