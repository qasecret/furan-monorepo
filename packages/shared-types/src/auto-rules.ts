import { z } from "zod";

export const autoRuleActionSchema = z.enum(["auto_approve", "flag"]);
export type AutoRuleAction = z.infer<typeof autoRuleActionSchema>;

export const matchSchema = z.object({
  type: z.enum(["selector"]),
  value: z.string().min(1),
});

export const conditionsSchema = z
  .object({
    maxDiff: z.number().min(0).max(100).optional(),
  })
  .optional()
  .nullable();

export const createAutoRuleInput = z.object({
  projectId: z.string().uuid(),
  label: z.string().min(1).max(200),
  match: matchSchema,
  conditions: conditionsSchema,
  action: autoRuleActionSchema,
});
export type CreateAutoRuleInput = z.infer<typeof createAutoRuleInput>;

export const updateAutoRuleInput = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  label: z.string().min(1).max(200).optional(),
  match: matchSchema.optional(),
  conditions: conditionsSchema,
  action: autoRuleActionSchema.optional(),
  enabled: z.boolean().optional(),
});
export type UpdateAutoRuleInput = z.infer<typeof updateAutoRuleInput>;
