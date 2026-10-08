// Renders the REAL sonner <Toaster> (only next-themes is mocked): the point of
// this component is how sonner's own CSS variables / inline styles land in the
// DOM, which a mocked Toaster cannot show.
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let resolvedTheme: string | undefined;
vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme }),
}));

import { ThemedToaster } from "../src/components/themed-toaster";

beforeEach(() => {
  resolvedTheme = undefined;
});

afterEach(() => {
  cleanup();
});

/** Mount the toaster, fire a toast, and return the toaster + toast elements. */
async function showToast(message: string) {
  render(<ThemedToaster />);
  act(() => {
    toast(message);
  });
  const toaster = await waitFor(() => {
    const el = document.querySelector<HTMLElement>("[data-sonner-toaster]");
    expect(el).not.toBeNull();
    return el!;
  });
  const toastEl = await waitFor(() => {
    const el = toaster.querySelector<HTMLElement>("[data-sonner-toast]");
    expect(el).not.toBeNull();
    return el!;
  });
  return { toaster, toastEl };
}

describe("ThemedToaster", () => {
  test("uses the light toast theme when the resolved theme is light", async () => {
    resolvedTheme = "light";
    const { toaster } = await showToast("light toast");
    expect(toaster.getAttribute("data-theme")).toBe("light");
  });

  test("uses the dark toast theme when the resolved theme is dark", async () => {
    resolvedTheme = "dark";
    const { toaster } = await showToast("dark toast");
    expect(toaster.getAttribute("data-theme")).toBe("dark");
  });

  test("defaults to dark before the theme resolves", async () => {
    resolvedTheme = undefined;
    const { toaster } = await showToast("unresolved toast");
    expect(toaster.getAttribute("data-theme")).toBe("dark");
  });

  test("drives sonner's surface variables from the raw design tokens", async () => {
    resolvedTheme = "dark";
    const { toaster } = await showToast("token toast");
    expect(toaster.style.getPropertyValue("--normal-bg")).toBe(
      "var(--overlay)",
    );
    expect(toaster.style.getPropertyValue("--normal-text")).toBe("var(--fg)");
    expect(toaster.style.getPropertyValue("--normal-border")).toBe(
      "var(--edge)",
    );
    expect(toaster.style.getPropertyValue("--border-radius")).toBe("10px");
  });

  test("gives each toast the overlay elevation as an inline box-shadow", async () => {
    resolvedTheme = "dark";
    const { toastEl } = await showToast("shadow toast");
    expect(toastEl.style.boxShadow).toBe("var(--elevation-overlay)");
  });

  test("keeps richColors and the bottom-right position", async () => {
    resolvedTheme = "dark";
    const { toaster, toastEl } = await showToast("position toast");
    expect(toastEl.getAttribute("data-rich-colors")).toBe("true");
    expect(toaster.getAttribute("data-y-position")).toBe("bottom");
    expect(toaster.getAttribute("data-x-position")).toBe("right");
  });
});
