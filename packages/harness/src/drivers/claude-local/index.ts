import type { ServerAdapterModule } from "@aaspai/contracts/harness";

export type { ClaudeLocalConfig, ClaudeStreamEvent } from "./config.js";
export { claudeLocalConfigSchema, claudeLocalInfo, DEFAULT_CLAUDE_LOCAL_CONFIG } from "./config.js";
export { claudeLocal } from "./execute.js";
export { formatClaudeTranscriptEntry } from "./format.js";
export { parseClaudeStreamLine } from "./parse.js";

import { claudeLocal } from "./execute.js";

/** Server-side module — what the host loads. */
export const module: ServerAdapterModule = claudeLocal;
