import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { Breadcrumbs } from "@/components/ui/breadcrumbs";

afterEach(cleanup);

describe("Breadcrumbs", () => {
  test("renders nothing for an empty trail", () => {
    const { container } = render(<Breadcrumbs items={[]} />);
    expect(container.firstChild).toBeNull();
  });

  test("links earlier crumbs and marks the last as the current page", () => {
    render(
      <Breadcrumbs
        items={[
          { label: "Projects", href: "/projects" },
          { label: "Acme", href: "/projects/1" },
          { label: "Runs" },
        ]}
      />,
    );

    const projects = screen.getByRole("link", { name: "Projects" });
    expect(projects.getAttribute("href")).toBe("/projects");

    // The trailing crumb is the current page: not a link, aria-current="page".
    expect(screen.queryByRole("link", { name: "Runs" })).toBeNull();
    expect(screen.getByText("Runs").getAttribute("aria-current")).toBe("page");
  });

  test("never links the last crumb, even when it carries an href", () => {
    render(<Breadcrumbs items={[{ label: "Solo", href: "/solo" }]} />);
    expect(screen.queryByRole("link", { name: "Solo" })).toBeNull();
    expect(screen.getByText("Solo").getAttribute("aria-current")).toBe("page");
  });
});
