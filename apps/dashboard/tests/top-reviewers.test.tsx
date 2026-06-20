import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { TopReviewers } from "@/app/(protected)/analytics/_components/top-reviewers";

afterEach(cleanup);

describe("TopReviewers", () => {
  test("renders a ranked leaderboard of reviewers", () => {
    render(
      <TopReviewers
        isLoading={false}
        items={[
          { userId: "u1", email: "alice@x.test", actions: 7 },
          { userId: "u2", email: "bob@x.test", actions: 3 },
        ]}
      />,
    );
    expect(screen.getByText("alice@x.test")).toBeDefined();
    expect(screen.getByText("7")).toBeDefined();
    expect(screen.getByText("bob@x.test")).toBeDefined();
    expect(screen.getByText("3")).toBeDefined();
    expect(screen.getByText("1")).toBeDefined(); // rank cell
  });

  test("labels the deleted-user bucket", () => {
    render(
      <TopReviewers
        isLoading={false}
        items={[{ userId: null, email: null, actions: 4 }]}
      />,
    );
    expect(screen.getByText("(deleted user)")).toBeDefined();
  });

  test("shows EmptyState when there is no reviewer activity", () => {
    render(<TopReviewers isLoading={false} items={[]} />);
    expect(screen.getByTestId("empty-state")).toBeDefined();
    expect(
      screen.getByText("No reviewer activity in this window."),
    ).toBeDefined();
  });

  test("shows skeleton rows while loading", () => {
    render(<TopReviewers isLoading={true} items={[]} />);
    expect(screen.getAllByTestId("reviewer-skeleton")).toHaveLength(5);
  });
});
