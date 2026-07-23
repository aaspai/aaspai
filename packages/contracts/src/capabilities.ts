import { z } from "zod";

/** Capability truth exposed by every registered harness or runtime target. */
export const providerCapabilitiesSchema = z
  .object({
    execute: z.boolean(),
    streaming: z.boolean(),
    cancellation: z.boolean(),
    timeout: z.boolean(),
    workspaceIsolation: z.boolean(),
    restore: z.boolean(),
    resume: z.boolean(),
    artifacts: z.boolean(),
    billing: z
      .enum(["api", "subscription", "metered_api", "credits", "free", "unknown"])
      .optional(),
  })
  .strict();
export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>;
