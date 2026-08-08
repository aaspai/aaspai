import { z } from "zod";

export const novitaConfigSchema = z
  .object({
    template: z.string().min(1).default("shellx-aliyun"),
    timeoutMs: z.number().positive().default(300_000),
  })
  .strict();

export type NovitaProviderConfig = z.infer<typeof novitaConfigSchema>;
