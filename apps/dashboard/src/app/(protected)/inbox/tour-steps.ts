import type { TourStep } from "@/components/tour/tour-context";

export const INBOX_TOUR_STEPS: TourStep[] = [
  {
    target: '[data-testid="page-header"]',
    title: "Batches",
    content:
      "Every test-result batch for your project lands here, opening on the ones that need review. Press Start reviewing to open the first step waiting for you.",
    placement: "bottom",
  },
  {
    target: "#inbox-status-filter",
    title: "Filter by status",
    content:
      "Narrow to the batches that need review or have a failed test, or browse Running and Passed. The chips, the branch and the search are reflected in the URL so you can bookmark or share a view.",
    placement: "bottom",
  },
  {
    target: "#inbox-batches-table",
    title: "Open a batch to review",
    content:
      "Each row is a batch. Click it to open the Review page, where you approve or reject the individual test results.",
    placement: "top",
  },
];
