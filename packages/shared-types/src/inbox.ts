import { z } from "zod";

import { runStatusSchema } from "./run-status.js";

export const inboxStatusFilter = z.enum(["all-open", "unresolved", "failed"]);
export type InboxStatusFilter = z.infer<typeof inboxStatusFilter>;

export const inboxWindowFilter = z.enum(["24h", "7d", "30d", "all"]);
export type InboxWindowFilter = z.infer<typeof inboxWindowFilter>;

export const inboxListInput = z.object({
  status: inboxStatusFilter.default("all-open"),
  projectIds: z.array(z.string().uuid()).nullish(),
  window: inboxWindowFilter.default("7d"),
  cursor: z.string().nullish(),
  limit: z.number().int().min(1).max(100).default(50),
});
export type InboxListInput = z.infer<typeof inboxListInput>;

export const inboxCountInput = z.object({
  window: inboxWindowFilter.default("7d"),
});
export type InboxCountInput = z.infer<typeof inboxCountInput>;

export const inboxRunRow = z.object({
  runId: z.string().uuid(),
  projectId: z.string().uuid(),
  projectName: z.string(),
  variationName: z.string(),
  buildNumber: z.number().int().nullable(),
  branch: z.string().nullable(),
  status: runStatusSchema,
  createdAt: z.string(),
  thumbnailUrl: z.string().nullable(),
});
export type InboxRunRow = z.infer<typeof inboxRunRow>;

export const inboxListOutput = z.object({
  items: z.array(inboxRunRow),
  nextCursor: z.string().nullable(),
});
export type InboxListOutput = z.infer<typeof inboxListOutput>;

export const inboxRejectInput = z.object({
  runId: z.string().uuid(),
  reason: z.string().max(500).nullish(),
});
export type InboxRejectInput = z.infer<typeof inboxRejectInput>;
