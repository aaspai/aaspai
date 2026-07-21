export * from "@aaspai/contracts/harness";
export { runProcess } from "./shared/run-process.js";
export type { RunProcessOptions, RunProcessResult } from "@aaspai/contracts/runtime";
export {
  REDACTED_HOME_PATH_USER,
  REDACTED_SECRET_VALUE,
  redactHomePath,
  redactHomePathInValue,
  redactCommandText,
  redactEnv,
} from "./shared/redact.js";
export {
  createRuntimeProgressReporter,
  RUNTIME_PROGRESS_PHASES,
} from "./shared/progress.js";
export type {
  RuntimeProgressSink,
  RuntimeProgressReporter,
  CreateRuntimeProgressReporterOptions,
} from "./shared/progress.js";
export { buildAgentEnv } from "./shared/env.js";
export {
  SshTransportUnavailableError,
  SSH_STUB_MESSAGE,
  ensureSshTransportAvailable,
} from "./shared/ssh.js";
export { SandboxTransportUnavailableError, SANDBOX_STUB_MESSAGE } from "./shared/sandbox.js";
export type { SandboxClient } from "@aaspai/contracts/runtime";

export {
  listAdapters,
  getAdapter,
  isAdapterReady,
  ADAPTER_REGISTRY_VERSION,
} from "./registry.js";

export { claudeLocal } from "./drivers/claude-local/index.js";
export {
  claudeLocalConfigSchema,
  claudeLocalInfo,
  DEFAULT_CLAUDE_LOCAL_CONFIG,
  parseClaudeStreamLine,
  formatClaudeTranscriptEntry,
} from "./drivers/claude-local/index.js";
export type { ClaudeLocalConfig, ClaudeStreamEvent } from "./drivers/claude-local/index.js";

export { codexLocal } from "./drivers/codex-local/index.js";
export {
  codexLocalConfigSchema,
  codexLocalInfo,
  DEFAULT_CODEX_LOCAL_CONFIG,
  parseCodexStreamLine,
  formatCodexTranscriptEntry,
} from "./drivers/codex-local/index.js";
export type { CodexLocalConfig, CodexStreamEvent } from "./drivers/codex-local/index.js";

export { cursorLocal } from "./drivers/cursor-local/index.js";
export { cursorLocalInfo } from "./drivers/cursor-local/index.js";
export { cursorCloud } from "./drivers/cursor-cloud/index.js";
export { cursorCloudInfo } from "./drivers/cursor-cloud/index.js";
export { openclawGateway } from "./drivers/openclaw-gateway/index.js";
export { openclawGatewayInfo } from "./drivers/openclaw-gateway/index.js";
export { hermesGateway } from "./drivers/hermes-gateway/index.js";
export { hermesGatewayInfo } from "./drivers/hermes-gateway/index.js";

export { dryRunLocal, dryRunLocalInfo } from "./drivers/dry-run-local/index.js";
export { opencodeLocal, opencodeLocalInfo, opencodeConfigSchema } from "./drivers/opencode-local/index.js";
export { opencodeCli, opencodeCliInfo } from "./drivers/opencode-cli/index.js";
