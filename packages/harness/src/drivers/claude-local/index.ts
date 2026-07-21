import type { ServerAdapterModule } from "@aaspai/contracts/harness";
export { claudeLocal } from "./execute.js";
export { claudeLocalConfigSchema, claudeLocalInfo, DEFAULT_CLAUDE_LOCAL_CONFIG } from "./config.js";
export type { ClaudeLocalConfig, ClaudeStreamEvent } from "./config.js";
export { parseClaudeStreamLine } from "./parse.js";
export { formatClaudeTranscriptEntry } from "./format.js";

import { claudeLocal } from "./execute.js";

/** Server-side module — what the host loads. */
export const module: ServerAdapterModule = claudeLocal;
