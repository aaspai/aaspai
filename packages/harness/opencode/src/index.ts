/**
 * Production OpenCode adapter.
 *
 * OpenCode is controlled through one authenticated `opencode serve` instance
 * per runtime/state scope. The server driver owns HTTP/SSE normalization; the
 * caller owns the runtime process boundary and prepared, secret-free config.
 */

export {
  buildOpencodeJson,
  type ConfigInjection,
  type OpenCodeResolvedConfig,
  prepareConfigInjection,
  resolveOpenCodeConfig,
} from "./config/index.js";
export {
  opencodeServer,
  shutdownManagedOpenCodeServers,
} from "./drivers/server/adapter.js";
export {
  OPENCODE_COMPATIBILITY_VERSION,
  type OpenCodeHealth,
  type OpenCodeMessage,
  OpenCodeServerClient,
  OpenCodeServerError,
  type OpenCodeServerEvent,
  type OpenCodeSession,
} from "./drivers/server/client.js";
export {
  type ManagedOpenCodeServer,
  type OpenCodeServerRuntime,
  startManagedOpenCodeServer,
} from "./drivers/server/lifecycle.js";
export type {
  OpenCodeNativeEvent,
  OpenCodeNativePart,
  OpenCodeToolState,
} from "./protocol/index.js";
export {
  type ApplyResult,
  createOpenCodeAccumulator,
  decodeOpenCodeLine,
  extractErrorMessage,
  type OpenCodeAccumulator,
  type OpenCodeRunState,
} from "./protocol/index.js";
export { opencodeSessionCodec } from "./session/codec.js";
export { decideResume, type ResumeContext, type ResumeDecision } from "./session/resume-policy.js";
