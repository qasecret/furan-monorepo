import type { TourStep } from "@/components/tour/tour-context";

export const INBOX_TOUR_STEPS: TourStep[] = [
  {
    target: "#inbox-header",
    title: "Inbox",
    content:
      "Every run across all your projects that needs a human decision lands here. Nothing slips through.",
    placement: "bottom",
  },
  {
    target: "#inbox-queue-list",
    title: "Approve or reject",
    content:
      "Each row is a run awaiting review. Press A to approve or R to reject the selected row. Use J/K or arrow keys to move between rows.",
    placement: "right",
  },
  {
    target: "#inbox-preview-pane",
    title: "Preview before you decide",
    content:
      "The selected run shows here — its change and a quick way to act — so you can approve or reject without opening the full diff. On a narrow screen, use the row's open-diff button instead.",
    placement: "left",
  },
  {
    target: '[data-testid="inbox-filter-bar"]',
    title: "Filter the queue",
    content:
      "Narrow by status, project, or time window. Filters are reflected in the URL so you can bookmark or share a specific view.",
    placement: "bottom",
  },
  {
    target: "#inbox-shortcut-hint",
    title: "Keyboard shortcuts",
    content:
      "Press ? at any time to open the full shortcut reference. The inbox is designed for keyboard-first triage.",
    placement: "bottom",
  },
];
