import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ThemeProvider } from "@/components/ui/theme-provider";

// next-themes reads the OS preference via window.matchMedia; jsdom doesn't
// implement it. `osPrefersDark` drives `matches` so each test can pick the OS.
let osPrefersDark = false;
class MockMatchMedia {
  constructor(private query: string) {}
  get matches() {
    return this.query.includes("dark") ? osPrefersDark : false;
  }
  addEventListener() {}
  removeEventListener() {}
  addListener() {}
  removeListener() {}
  dispatchEvent() {
    return false;
  }
}
// @ts-expect-error -- jsdom doesn't have matchMedia
global.matchMedia = (q: string) => new MockMatchMedia(q);

const html = () => document.documentElement;

beforeEach(() => {
  localStorage.clear();
  html().className = "";
  osPrefersDark = false;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  html().className = "";
});

describe("ThemeProvider", () => {
  test("no stored choice + OS dark → html has class dark", async () => {
    osPrefersDark = true;
    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>,
    );
    await waitFor(() => expect(html().classList.contains("dark")).toBe(true));
  });

  test("no stored choice + OS light → html lacks class dark", async () => {
    osPrefersDark = false;
    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>,
    );
    // Wait for next-themes to apply the resolved (light) class, then assert
    // dark was never added.
    await waitFor(() => expect(html().classList.contains("light")).toBe(true));
    expect(html().classList.contains("dark")).toBe(false);
  });

  test("stored furan-theme=dark wins over OS light", async () => {
    osPrefersDark = false;
    localStorage.setItem("furan-theme", "dark");
    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>,
    );
    await waitFor(() => expect(html().classList.contains("dark")).toBe(true));
  });

  test("stored furan-theme=light wins over OS dark", async () => {
    osPrefersDark = true;
    localStorage.setItem("furan-theme", "light");
    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>,
    );
    await waitFor(() => expect(html().classList.contains("light")).toBe(true));
    expect(html().classList.contains("dark")).toBe(false);
  });
});
