import { cleanup, render, screen, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, test } from "vitest";

import {
  ConnectSdkCard,
  tokenPageFor,
} from "@/components/onboarding/connect-sdk-card";
import { CommandRoleProvider } from "@/lib/commands/registry";
import { docsHref } from "@/lib/docs-href";
import { browserEnv } from "@/lib/env";
import type { ViewerRole } from "@/lib/roles";
import { absoluteApiUrl } from "@/lib/use-api-url";

afterEach(() => {
  cleanup();
});

function renderAs(role: ViewerRole) {
  return render(
    <CommandRoleProvider role={role}>
      <ConnectSdkCard projectId="p1" />
    </CommandRoleProvider>,
  );
}

describe("ConnectSdkCard", () => {
  test("names the three values and gives the URL and ID to copy", () => {
    renderAs("editor");
    const card = screen.getByTestId("connect-sdk-card");
    expect(within(card).getByText("Connect the SDK")).toBeDefined();
    expect(
      within(card).getByText("Set these three values where your tests run."),
    ).toBeDefined();
    for (const name of ["FURAN_API_URL", "FURAN_PROJECT_ID", "FURAN_API_TOKEN"])
      expect(within(card).getByText(name)).toBeDefined();
    expect(
      within(card).getByTestId("connect-api-url").querySelector("code")
        ?.textContent,
    ).toBe(
      absoluteApiUrl(browserEnv.NEXT_PUBLIC_API_URL, window.location.origin),
    );
    expect(
      within(card).getByTestId("connect-project-id").querySelector("code")
        ?.textContent,
    ).toBe("p1");
    expect(
      within(card).getByText(
        "If your CI reaches Furan by another address, use that one.",
      ),
    ).toBeDefined();
  });

  test.each([
    ["owner", "/admin/api-keys"],
    ["admin", "/admin/api-keys"],
    ["editor", "/account/tokens"],
  ] as const)("a %s creates a token at %s", (role, href) => {
    renderAs(role);
    const link = screen.getByRole("link", { name: "Create an API token →" });
    expect(link.getAttribute("href")).toBe(href);
  });

  test("a guest is told to ask an admin", () => {
    renderAs("guest");
    expect(screen.getByText("Ask an admin for an API token.")).toBeDefined();
    expect(
      screen.queryByRole("link", { name: "Create an API token →" }),
    ).toBeNull();
  });

  test("links each driver's tab and the full guide", () => {
    renderAs("editor");
    for (const [name, driver] of [
      ["Selenium", "selenium"],
      ["Playwright", "playwright"],
      ["Appium", "appium"],
      ["REST", "rest"],
    ] as const) {
      expect(
        screen
          .getByRole("link", { name: `${name} (opens in a new tab)` })
          .getAttribute("href"),
      ).toBe(docsHref("getting-started/first-upload", { driver }));
    }
    expect(
      screen
        .getByRole("link", { name: "Full guide (opens in a new tab)" })
        .getAttribute("href"),
    ).toBe(docsHref("getting-started/first-upload"));
  });

  test("the server render holds no URL, only a placeholder", () => {
    const html = renderToString(<ConnectSdkCard projectId="p1" />);
    // (Not "no http://" at all: the icons' SVG xmlns is one.)
    expect(html).not.toContain('data-testid="connect-api-url"');
    expect(html).not.toContain(browserEnv.NEXT_PUBLIC_API_URL);
    expect(html).toContain('data-testid="api-url-pending"');
  });
});

describe("tokenPageFor", () => {
  test("admins and owners use Admin, editors their own page, others none", () => {
    expect(tokenPageFor("owner")).toBe("/admin/api-keys");
    expect(tokenPageFor("admin")).toBe("/admin/api-keys");
    expect(tokenPageFor("editor")).toBe("/account/tokens");
    expect(tokenPageFor("guest")).toBeNull();
    expect(tokenPageFor("bogus")).toBeNull();
  });
});
