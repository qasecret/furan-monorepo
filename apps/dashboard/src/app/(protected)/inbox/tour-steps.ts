import type { TourStep } from "@/components/tour/tour-context";

export const INBOX_TOUR_STEPS: TourStep[] = [
  {
    target: '[data-testid="page-header"]',
    title: "Inbox",
    content:
      "Every test-result batch for your project lands here. Search or refresh from the header.",
    placement: "bottom",
  },
  {
    target: "#inbox-status-filter",
    title: "Filter by status",
    content:
      "Narrow to the batches that need attention — Unresolved or Failed — or browse Passed and Running. The filter is reflected in the URL so you can bookmark or share a view.",
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
