import { z } from "zod";
import { ITEM_FIELDS, TRANSLATE_MODES } from "../types.js";

export const DEFAULT_FEED_LIMIT = 25;
export const DEFAULT_TRANSLATE_MODE = "bilingual";

const translateSystemSchema = z.object({
  systemPrompt: z.string().trim().min(1),
});

const summarySystemSchema = z.object({
  systemPrompt: z.string().trim().min(1),
});

const feedTranslateSchema = z.object({
  targetLanguage: z.string().trim().min(1),
  mode: z.enum(TRANSLATE_MODES).default(DEFAULT_TRANSLATE_MODE),
  fields: z.array(z.enum(ITEM_FIELDS)).nonempty(),
});

const feedSummarySchema = z.object({
  sourceField: z.enum(ITEM_FIELDS),
  prompt: z.string().trim().min(1),
});

const rawFeedSchema = z.object({
  path: z.string(),
  url: z.string().trim().min(1),
  limit: z.number().int().positive().default(DEFAULT_FEED_LIMIT),
  translate: feedTranslateSchema.optional(),
  summary: feedSummarySchema.optional(),
}).refine((feed) => !!feed.translate || !!feed.summary, {
  message: "feed must enable at least one feature",
});

export const rawConfigSchema = z.object({
  translate: translateSystemSchema.optional(),
  summary: summarySystemSchema.optional(),
  feeds: z.array(rawFeedSchema).nonempty(),
}).superRefine((config, ctx) => {
  if (config.feeds.some((feed) => !!feed.translate) && !config.translate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "global translate.systemPrompt is required when any feed enables translate",
      path: ["translate", "systemPrompt"],
    });
  }
  if (config.feeds.some((feed) => !!feed.summary) && !config.summary) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "global summary.systemPrompt is required when any feed enables summary",
      path: ["summary", "systemPrompt"],
    });
  }
});

export type RawConfig = z.infer<typeof rawConfigSchema>;
