import { z } from "zod";

/**
 * The only native configuration OpenCode receives from the caller. It must be
 * prepared by the layer that owns providers/skills/MCP and is checked for
 * resolved secrets before it crosses the runtime boundary.
 */
const nativeConfigSchema = z.record(z.string().max(256), z.unknown()).default({});

const stringArray = z.array(z.string().trim().min(1).max(4_096)).max(64).default([]);

const positiveInteger = (max: number) => z.coerce.number().int().min(1).max(max).optional();

const positiveNumber = (max: number) => z.coerce.number().positive().max(max).optional();

/** Stable OpenCode server configuration. Unknown keys are rejected. */
export const opencodeConfigSchema = z
  .object({
    model: z.string().trim().min(1).max(256).optional(),
    agent: z.string().trim().min(1).max(128).optional(),
    variant: z.string().trim().min(1).max(128).optional(),
    title: z.string().trim().min(1).max(512).optional(),
    command: z.string().trim().min(1).max(4_096).optional(),
    commandArgs: stringArray,
    transport: z.enum(["server", "cli"]).default("server"),
    serverUrl: z.string().trim().url().optional(),
    serverUsername: z.string().trim().min(1).max(256).optional(),
    serverPassword: z.string().trim().min(1).max(1_024).optional(),
    serverExpectedVersion: z.string().trim().min(1).max(128).optional(),
    serverStartupTimeoutMs: positiveInteger(120_000),
    port: z.coerce.number().int().min(1).max(65_535).optional(),
    timeoutSec: positiveNumber(86_400 * 7),
    graceSec: positiveNumber(300),
    pure: z.boolean().default(false),
    permissions: z.record(z.string().max(256), z.unknown()).optional(),
    nativeConfig: nativeConfigSchema,
    disableProjectConfig: z.boolean().default(true),
  })
  .strict();

export type OpenCodeConfig = z.infer<typeof opencodeConfigSchema>;

export function parseOpenCodeConfig(input: unknown): OpenCodeConfig {
  return opencodeConfigSchema.parse(input ?? {});
}
