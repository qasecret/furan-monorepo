import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { DocsLink } from "@/components/docs-link";

afterEach(() => {
  cleanup();
});

describe("DocsLink", () => {
  test("opens the docs page in a new tab", () => {
    render(
      <DocsLink slug="getting-started/first-upload" query={{ driver: "rest" }}>
        Full guide
      </DocsLink>,
    );
    const link = screen.getByRole("link");
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe(
      "/docs/getting-started/first-upload?driver=rest",
    );
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  test("says it opens in a new tab, and hides the icon", () => {
    render(<DocsLink slug="getting-started/install">Getting started</DocsLink>);
    const link = screen.getByRole("link", {
      name: "Getting started (opens in a new tab)",
    });
    const hidden = link.querySelector(".sr-only");
    expect(hidden?.textContent).toBe("(opens in a new tab)");
    expect(link.textContent?.endsWith("(opens in a new tab)")).toBe(true);
    const icon = link.querySelector("svg");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  });

  test("links the portal home without a slug", () => {
    render(<DocsLink>Documentation</DocsLink>);
    expect(screen.getByRole("link").getAttribute("href")).toBe("/docs");
  });

  test("passes className and other props through", () => {
    render(
      <DocsLink className="custom" data-testid="docs" slug="sdk/rest">
        REST
      </DocsLink>,
    );
    const link = screen.getByTestId("docs");
    expect(link.className).toBe("custom");
    expect(link.getAttribute("href")).toBe("/docs/sdk/rest");
  });

  test("uses the app's link style by default", () => {
    render(<DocsLink slug="sdk/kotlin">Kotlin</DocsLink>);
    expect(screen.getByRole("link").className).toBe(
      "text-brand-text hover:underline focus-ring",
    );
  });
});
