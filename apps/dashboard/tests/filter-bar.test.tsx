import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

const replaceMock = vi.fn();
const paramsRef = { current: new URLSearchParams() };
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
  useSearchParams: () => paramsRef.current,
}));

import { FilterBar } from "@/app/(protected)/inbox/_components/filter-bar";

afterEach(() => {
  cleanup();
  replaceMock.mockClear();
  paramsRef.current = new URLSearchParams();
});

describe("FilterBar", () => {
  test("renders a labelled Filter group", () => {
    render(<FilterBar status="all-open" window="7d" groupBy={false} />);
    expect(screen.getByText(/^Filter$/i)).toBeDefined();
    expect(screen.getByTestId("inbox-filter-bar")).toBeDefined();
  });

  test("toggling 'Group similar changes' navigates with the group param", () => {
    render(<FilterBar status="all-open" window="7d" groupBy={false} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(replaceMock).toHaveBeenCalledWith(
      expect.stringContaining("group=similarity"),
      expect.objectContaining({ scroll: false }),
    );
  });
});
