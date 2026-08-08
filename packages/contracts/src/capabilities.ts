import { z } from "zod";

/**
 * Capability truth exposed by every registered harness or runtime target.
 *
 * Billing is deliberately NOT a capability: it is execution metadata
 * (the `billingType` / `biller` on an execution result), not a static
 * property of a provider. A provider's actual billing mode is decided
 * per-run by the runtime environment (e.g. Claude Code can be
 * subscription / API / AWS Bedrock; Codex can be API or ChatGPT plan).
 */
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
  })
  .strict();
export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>;
