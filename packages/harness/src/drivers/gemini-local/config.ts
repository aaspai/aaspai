import { nonNegativeIntegerSchema, positiveIntegerSchema } from "@aaspai/contracts/primitives";
import { z } from "zod";

export const geminiLocalConfigSchema = z
  .object({
    command: z.string().trim().min(1).max(256).default("gemini"),
    model: z.string().trim().min(1).max(256).optional(),
    engine: z.enum(["auto", "cli", "acp"]).default("auto"),
    agentCommand: z.string().trim().min(1).max(4_096).optional(),
    mode: z.enum(["persistent", "oneshot"]).optional(),
    permissionMode: z.string().trim().min(1).max(64).optional(),
    acpPermissionMode: z.enum(["approve-all", "approve-reads", "deny-all"]).optional(),
    nonInteractivePermissions: z.enum(["deny", "fail"]).optional(),
    stateDir: z.string().trim().min(1).max(8_192).optional(),
    acpStateDir: z.string().trim().min(1).max(8_192).optional(),
    acpAllowedTools: z.array(z.string().trim().min(1).max(128)).max(128).optional(),
    warmHandleIdleMs: nonNegativeIntegerSchema.max(86_400_000).optional(),
    maxTurns: positiveIntegerSchema.max(1_000).optional(),
    timeoutSec: positiveIntegerSchema.max(86_400).optional(),
    graceSec: positiveIntegerSchema.max(300).default(15),
    extraArgs: z.array(z.string().max(1_024)).max(64).default([]),
    env: z.record(z.string(), z.string()).default({}),
    cwd: z.string().trim().min(1).max(8_192).optional(),
  })
  .strict();

export type GeminiLocalConfig = z.infer<typeof geminiLocalConfigSchema>;

export function parseGeminiLocalConfig(input: unknown): GeminiLocalConfig {
  return geminiLocalConfigSchema.parse(input ?? {});
}
