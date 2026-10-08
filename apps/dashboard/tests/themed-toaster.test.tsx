import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let captured: Record<string, unknown> = {};
vi.mock("sonner", () => ({
  Toaster: (p: Record<string, unknown>) => {
    captured = p;
    return null;
  },
}));

let resolvedTheme: string | undefined;
vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme }),
}));

import { ThemedToaster } from "../src/components/themed-toaster";

beforeEach(() => {
  captured = {};
  resolvedTheme = undefined;
});

afterEach(() => {
  cleanup();
});

describe("ThemedToaster", () => {
  test("uses the light toast theme when the resolved theme is light", () => {
    resolvedTheme = "light";
    render(<ThemedToaster />);
    expect(captured.theme).toBe("light");
  });

  test("uses the dark toast theme when the resolved theme is dark", () => {
    resolvedTheme = "dark";
    render(<ThemedToaster />);
    expect(captured.theme).toBe("dark");
  });

  test("defaults to dark before the theme resolves", () => {
    resolvedTheme = undefined;
    render(<ThemedToaster />);
    expect(captured.theme).toBe("dark");
  });

  test("keeps richColors, position and the overlay token classes", () => {
    resolvedTheme = "dark";
    render(<ThemedToaster />);
    expect(captured.richColors).toBe(true);
    expect(captured.position).toBe("bottom-right");
    expect(captured.toastOptions).toEqual({
      className: "rounded-overlay bg-overlay text-fg shadow-overlay",
    });
  });
});
