import { z } from "zod";

export const e2bConfigSchema = z
  .object({
    template: z.string().min(1).default("base"),
    timeoutMs: z.number().positive().default(3_600_000),
  })
  .strict();

export type E2bProviderConfig = z.infer<typeof e2bConfigSchema>;
