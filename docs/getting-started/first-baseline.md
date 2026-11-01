---
title: 5. Approve your first baselines
sidebar_label: Approve your first baselines
---

# 5. Approve your first baselines

A **baseline** is the approved screenshot every later run of the same step is
compared with. Furan does not pick one for you: the first time a step runs,
it is **New**, and a person decides that this is what correct looks like.
That's deliberate. A baseline nobody looked at would let a broken page
become the reference.

## You need

- A batch with **New** steps ([step 4](first-upload.mdx)).
- An account that can review the project (admin or editor).

## Steps

Open the batch from **Batches** (click its row, or **Start reviewing**). Then
approve its steps all at once or one by one.

**All at once.** On the Review page, click **Approve pending (N)**. The dialog,
"Approve pending steps?", says how many steps and tests it covers: "Each
step's screenshot becomes its baseline." Click **Approve N steps**.

**One by one.** Open a step. The viewer shows the screenshot alone, with "No
baseline yet. Approve this step to make it the baseline." Check it, then click
**Save as baseline**. Do this for each step you want to keep.

### What makes a step "the same" next time

A baseline belongs to one step identity: the same **test name** and **step
name**, on the same **branch**, **browser**, **viewport** and **OS/device**.
Keep those stable between runs; renaming a test or a step starts a new,
baseline-less step.

Branches fall back to the project's main branch: a feature branch with no
baseline of its own compares against main's.

## You should see

The batch's steps move from **New** to approved, and the batch drops out of
the default **Needs review** filter in **Batches**.

## If it doesn't work

- **No Approve buttons:** your account may be a guest, or not a member of the
  project. Ask an admin.
- **You'd rather first captures became baselines automatically:** the project
  setting **Auto-approve feature branches** (project Settings → Diff behavior)
  does that, along with approving feature-branch runs. It is off by default,
  and the manual first approval above is the recommended path.

---

**Previous:** [4. Send your first upload](first-upload.mdx) · **Next:** [6. Review your first diff](first-diff.md)
