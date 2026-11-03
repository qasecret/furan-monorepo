---
title: 6. Review your first diff
sidebar_label: Review your first diff
---

# 6. Review your first diff

With baselines in place, every run is compared with them. A step that matches
**passes**; a step that differs is **Unresolved** until someone reviews it.

## You need

- Approved baselines ([step 5](first-baseline.md)).

## Steps

1. Change something visible in the page your test opens (a heading, a
   colour), or point the test at a slightly different page, keeping the same
   test and step names. A new project passes a step when at most **0.1%** of
   its pixels differ (project Settings → Diff behavior → **Diff threshold**):
   on a 1280×720 screenshot that is about 920 pixels, so a few changed words
   can pass. For this walkthrough change something larger, or set the
   threshold to 0%.
2. Run the same test again.
3. In **Batches**, the new batch shows **Unresolved**. Open it, then open the
   changed step.
4. Compare the screenshots. The toolbar switches between **Side by side**,
   **Swipe**, **Flicker**, **Overlay** and **Diff**, and the changed regions
   are outlined and listed.
5. Decide:
   - **Approve** if the change is intended. The new screenshot becomes the
     baseline.
   - **Reject** if it's a bug. The baseline stays as it was, and the step
     counts as failed.

Press `?` anywhere for the keyboard shortcuts: you can review a whole batch
without the mouse.

## You should see

The step moves from **Unresolved** to approved or rejected, and the next run
compares against whatever you approved.

## If it doesn't work

- **The run passed although something changed:** the change may be under the
  project's diff threshold (0.1% of the pixels by default, which a short text
  change such as a price can stay under), or inside an ignore region. Both are
  in project Settings. The viewer's toolbar shows the threshold it applied as
  **Sensitivity**.
- **Every run shows small differences:** dynamic content (dates, ads,
  animations) differs on every capture. Ignore those areas, or make the page
  deterministic in the test.

---

**Previous:** [5. Approve your first baselines](first-baseline.md) · **Next:** [7. Wire it into CI](next-ci.md)
