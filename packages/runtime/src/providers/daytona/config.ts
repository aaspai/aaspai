import { z } from "zod";

export const resourceSchema = z
  .object({
    cpu: z.number().positive().optional(),
    memory: z.number().positive().optional(),
    disk: z.number().positive().optional(),
    gpu: z.number().positive().optional(),
  })
  .strict();

export const daytonaConfigSchema = z
  .object({
    apiUrl: z.string().trim().url().optional(),
    target: z.string().trim().min(1).max(128).optional(),
    snapshot: z.string().trim().min(1).max(256).optional(),
    image: z.string().trim().min(1).max(512).optional(),
    timeoutMs: z.number().int().positive().max(86_400_000).default(300_000),
    resources: resourceSchema.optional(),
    /** Provider-side safety defaults. Values are minutes, not session TTL. */
    autoStopMinutes: z.number().nonnegative().default(15),
    autoArchiveMinutes: z.number().nonnegative().default(60),
    autoDeleteMinutes: z
      .number()
      .int()
      .min(-1)
      .default(7 * 24 * 60),
    /** Millisecond aliases retained for callers already using the V2 draft. */
    autoStopInterval: z.number().int().min(0).optional(),
    autoArchiveInterval: z.number().int().min(0).optional(),
    autoDeleteInterval: z.number().int().min(-1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.image && value.snapshot) {
      ctx.addIssue({
        code: "custom",
        path: ["snapshot"],
        message: "image and snapshot are mutually exclusive",
      });
    }
  })
  .strict();

type ParsedDaytonaConfig = z.infer<typeof daytonaConfigSchema>;
/** Accept draft configs before provider defaults are materialized. */
export type DaytonaProviderConfig = Omit<
  ParsedDaytonaConfig,
  "autoStopMinutes" | "autoArchiveMinutes" | "autoDeleteMinutes"
> &
  Partial<
    Pick<ParsedDaytonaConfig, "autoStopMinutes" | "autoArchiveMinutes" | "autoDeleteMinutes">
  >;

/** Resolve the draft millisecond aliases into the provider's minute fields. */
export function normalizeDaytonaConfig(input: unknown): ParsedDaytonaConfig {
  const parsed = daytonaConfigSchema.parse(input ?? {});
  return {
    ...parsed,
    autoStopMinutes:
      parsed.autoStopInterval === undefined
        ? parsed.autoStopMinutes
        : parsed.autoStopInterval / 60_000,
    autoArchiveMinutes:
      parsed.autoArchiveInterval === undefined
        ? parsed.autoArchiveMinutes
        : parsed.autoArchiveInterval / 60_000,
    autoDeleteMinutes:
      parsed.autoDeleteInterval === undefined
        ? parsed.autoDeleteMinutes
        : parsed.autoDeleteInterval < 0
          ? -1
          : parsed.autoDeleteInterval / 60_000,
  };
}
