import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

const record = vi.fn();
vi.mock("@/lib/recent-projects", () => ({
  recordRecentProject: (...a: unknown[]) => record(...a),
}));

import { RecordRecentProject } from "@/app/(protected)/projects/[projectId]/_components/record-recent-project";

afterEach(() => {
  cleanup();
  record.mockClear();
});

test("records the project visit on mount", () => {
  render(<RecordRecentProject projectId="p1" name="alpha" />);
  expect(record).toHaveBeenCalledWith({ id: "p1", name: "alpha" });
});
