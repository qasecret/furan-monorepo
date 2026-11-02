import { cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, test } from "vitest";

import { browserEnv } from "@/lib/env";
import { absoluteApiUrl, useApiUrl } from "@/lib/use-api-url";

afterEach(() => {
  cleanup();
});

function Probe() {
  const url = useApiUrl();
  return <span data-testid="url">{url ?? "pending"}</span>;
}

describe("absoluteApiUrl", () => {
  test("a root-relative base becomes absolute on the page's origin", () => {
    // The one-file install's -proxy image: NEXT_PUBLIC_API_URL=/api.
    expect(absoluteApiUrl("/api", "http://10.0.0.5:8080")).toBe(
      "http://10.0.0.5:8080/api",
    );
  });

  test("an absolute base is left as it is", () => {
    expect(absoluteApiUrl("http://localhost:3000", "http://x:3001")).toBe(
      "http://localhost:3000",
    );
  });

  test("a path is kept and a trailing slash dropped", () => {
    expect(absoluteApiUrl("https://furan.example.com/api/", "http://x")).toBe(
      "https://furan.example.com/api",
    );
  });
});

describe("useApiUrl", () => {
  test("is null in the server render, so hydration can't disagree", () => {
    expect(renderToString(<Probe />)).toContain("pending");
  });

  test("is the absolute API URL in the browser", () => {
    render(<Probe />);
    expect(screen.getByTestId("url").textContent).toBe(
      absoluteApiUrl(browserEnv.NEXT_PUBLIC_API_URL, window.location.origin),
    );
  });
});
