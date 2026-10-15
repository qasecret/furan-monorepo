import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const facetsMock = vi.fn();
vi.mock("@/lib/trpc", () => ({
  trpc: {
    runs: { facets: { useQuery: (...a: unknown[]) => facetsMock(...a) } },
  },
}));

import { FacetSelects } from "@/app/(protected)/projects/[projectId]/builds/[buildId]/_components/facet-selects";

const FACETS = {
  browser: [
    { value: "chromium", pending: 3 },
    { value: "firefox", pending: 0 },
  ],
  viewport: [
    { value: "1280x720", pending: 2 },
    { value: "390x844", pending: 1 },
  ],
  os: [],
  device: [],
};

function answer(data: typeof FACETS | undefined = FACETS) {
  facetsMock.mockReturnValue({ data, isLoading: data === undefined });
}

beforeEach(() => {
  facetsMock.mockReset();
  answer();
});
afterEach(cleanup);

/** The select of a dimension, by the name it announces ("Browser: Any browser"). */
const select = (name: RegExp) => screen.getByRole("combobox", { name });
const named = (dimension: string) => new RegExp(`^${dimension}:`, "i");

/** Opens a select and returns its options' text, in order. */
async function optionsOf(name: RegExp): Promise<string[]> {
  fireEvent.click(select(name));
  const options = await screen.findAllByRole("option");
  return options.map((o) => o.textContent ?? "");
}

describe("FacetSelects", () => {
  test("asks for the batch's environment values", () => {
    render(<FacetSelects buildId="b1" facets={{}} onChange={vi.fn()} />);
    expect(facetsMock).toHaveBeenCalledWith({ buildId: "b1" });
  });

  test("offers one select per dimension that has values, and none for the rest", () => {
    render(<FacetSelects buildId="b1" facets={{}} onChange={vi.fn()} />);
    expect(select(named("browser"))).toBeDefined();
    expect(select(named("viewport"))).toBeDefined();
    // No step of the batch has an OS or a device (desktop steps).
    expect(screen.queryByRole("combobox", { name: named("os") })).toBeNull();
    expect(
      screen.queryByRole("combobox", { name: named("device") }),
    ).toBeNull();
  });

  test("renders nothing until there is something to choose", () => {
    answer({ browser: [], viewport: [], os: [], device: [] });
    const { container } = render(
      <FacetSelects buildId="b1" facets={{}} onChange={vi.fn()} />,
    );
    expect(container.textContent).toBe("");
  });

  test("an unset dimension reads 'Any ‹dimension›'", () => {
    render(<FacetSelects buildId="b1" facets={{}} onChange={vi.fn()} />);
    expect(select(named("browser")).textContent).toContain("Any browser");
    expect(select(named("viewport")).textContent).toContain("Any viewport");
  });

  test("the options are the values with their pending counts, after 'Any'", async () => {
    render(<FacetSelects buildId="b1" facets={{}} onChange={vi.fn()} />);
    expect(await optionsOf(named("browser"))).toEqual([
      "Any browser",
      "chromium · 3 pending",
      "firefox · 0 pending",
    ]);
  });

  test("picking a value reports the facets with it set, keeping the others", async () => {
    const onChange = vi.fn();
    render(
      <FacetSelects
        buildId="b1"
        facets={{ viewport: "390x844" }}
        onChange={onChange}
      />,
    );
    await optionsOf(named("browser"));
    fireEvent.click(
      screen.getByRole("option", { name: "firefox · 0 pending" }),
    );
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith({
      viewport: "390x844",
      browser: "firefox",
    });
  });

  test("'Any ‹dimension›' clears that facet and only that one", async () => {
    const onChange = vi.fn();
    render(
      <FacetSelects
        buildId="b1"
        facets={{ browser: "firefox", viewport: "390x844" }}
        onChange={onChange}
      />,
    );
    await optionsOf(named("browser"));
    fireEvent.click(screen.getByRole("option", { name: "Any browser" }));
    expect(onChange).toHaveBeenCalledOnce();
    const next = onChange.mock.calls[0]![0] as Record<string, string>;
    expect(next).toEqual({ viewport: "390x844" });
    // Cleared, not set to something empty: the URL writer drops absent keys.
    expect("browser" in next).toBe(false);
  });

  test("the trigger shows the chosen value, not the whole option", () => {
    render(
      <FacetSelects
        buildId="b1"
        facets={{ browser: "chromium" }}
        onChange={vi.fn()}
      />,
    );
    expect(select(named("browser")).textContent).toContain("chromium");
    expect(select(named("browser")).textContent).not.toContain("pending");
  });

  test("a value the batch does not have is shown as '(not in this batch)' and can be cleared", async () => {
    const onChange = vi.fn();
    render(
      <FacetSelects
        buildId="b1"
        facets={{ viewport: "9999x9999" }}
        onChange={onChange}
      />,
    );
    expect(select(named("viewport")).textContent).toContain(
      "9999x9999 (not in this batch)",
    );
    expect(await optionsOf(named("viewport"))).toEqual([
      "Any viewport",
      "1280x720 · 2 pending",
      "390x844 · 1 pending",
      "9999x9999 (not in this batch)",
    ]);
    fireEvent.click(screen.getByRole("option", { name: "Any viewport" }));
    expect(onChange).toHaveBeenCalledWith({});
  });

  test("a dimension the batch has no values for still shows a value the URL names", () => {
    render(
      <FacetSelects
        buildId="b1"
        facets={{ device: "Pixel 8" }}
        onChange={vi.fn()}
      />,
    );
    expect(select(named("device")).textContent).toContain(
      "Pixel 8 (not in this batch)",
    );
  });

  test("until the values arrive a chosen value is shown as it is, not called missing", () => {
    answer(undefined);
    render(
      <FacetSelects
        buildId="b1"
        facets={{ browser: "firefox" }}
        onChange={vi.fn()}
      />,
    );
    expect(select(named("browser")).textContent).toContain("firefox");
    expect(select(named("browser")).textContent).not.toContain(
      "not in this batch",
    );
  });

  test("reports nothing until the reviewer chooses", () => {
    // Radix Select can report "" while its items register; that is never a facet.
    const onChange = vi.fn();
    render(<FacetSelects buildId="b1" facets={{}} onChange={onChange} />);
    expect(onChange).not.toHaveBeenCalled();
  });
});
