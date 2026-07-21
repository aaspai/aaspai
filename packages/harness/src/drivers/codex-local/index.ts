import type { ServerAdapterModule } from "@aaspai/contracts/harness";
export { codexLocal } from "./execute.js";
export { codexLocalConfigSchema, codexLocalInfo, DEFAULT_CODEX_LOCAL_CONFIG } from "./config.js";
export type { CodexLocalConfig, CodexStreamEvent } from "./config.js";
export { parseCodexStreamLine } from "./parse.js";
export { formatCodexTranscriptEntry } from "./format.js";

import { codexLocal } from "./execute.js";

/** Server-side module — what the host loads. */
export const module: ServerAdapterModule = codexLocal;
