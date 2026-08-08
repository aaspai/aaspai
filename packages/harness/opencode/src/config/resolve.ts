import { type OpenCodeConfig, opencodeConfigSchema } from "./schema.js";

export interface OpenCodeResolvedConfig {
  model: string;
  agent?: string;
  variant?: string;
  title: string;
  command?: string;
  commandArgs: string[];
  transport: "server" | "cli";
  serverUrl?: string;
  serverUsername?: string;
  serverPassword?: string;
  serverExpectedVersion?: string;
  serverStartupTimeoutMs?: number;
  port?: number;
  timeoutSec: number;
  graceSec: number;
  pure: boolean;
  permissions?: Record<string, unknown>;
  nativeConfig: Record<string, unknown>;
  disableProjectConfig: boolean;
}

const DEFAULT_MODEL = "opencode-go/mimo-v2.5";
const DEFAULT_TITLE = "OpenCode Session";

export function resolveOpenCodeConfig(raw: unknown): OpenCodeResolvedConfig {
  const cfg: OpenCodeConfig = opencodeConfigSchema.parse(raw ?? {});
  return {
    model: cfg.model ?? DEFAULT_MODEL,
    agent: cfg.agent,
    variant: cfg.variant,
    title: cfg.title ?? DEFAULT_TITLE,
    command: cfg.command,
    commandArgs: cfg.commandArgs,
    transport: cfg.transport,
    serverUrl: cfg.serverUrl,
    serverUsername: cfg.serverUsername,
    serverPassword: cfg.serverPassword,
    serverExpectedVersion: cfg.serverExpectedVersion,
    serverStartupTimeoutMs: cfg.serverStartupTimeoutMs,
    port: cfg.port,
    timeoutSec: Math.max(1, cfg.timeoutSec ?? 86_400),
    graceSec: Math.max(1, cfg.graceSec ?? 15),
    pure: cfg.pure,
    permissions: cfg.permissions,
    nativeConfig: cfg.nativeConfig,
    disableProjectConfig: cfg.disableProjectConfig,
  };
}

export type { OpenCodeConfig } from "./schema.js";
export { opencodeConfigSchema } from "./schema.js";
