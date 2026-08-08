export { opencodeServer, shutdownManagedOpenCodeServers } from "./adapter.js";
export {
  OPENCODE_COMPATIBILITY_VERSION,
  type OpenCodeHealth,
  type OpenCodeMessage,
  OpenCodeServerClient,
  OpenCodeServerError,
  type OpenCodeServerEvent,
  type OpenCodeSession,
} from "./client.js";
export {
  type ManagedOpenCodeServer,
  type OpenCodeServerRuntime,
  startManagedOpenCodeServer,
} from "./lifecycle.js";
