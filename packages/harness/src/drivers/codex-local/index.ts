import type { ServerAdapterModule } from "@aaspai/contracts/harness";

export type { CodexLocalConfig, CodexStreamEvent } from "./config.js";
export { codexLocalConfigSchema, codexLocalInfo, DEFAULT_CODEX_LOCAL_CONFIG } from "./config.js";
export { codexLocal } from "./execute.js";
export { formatCodexTranscriptEntry } from "./format.js";
export { parseCodexStreamLine } from "./parse.js";

import { codexLocal } from "./execute.js";

/** Server-side module — what the host loads. */
export const module: ServerAdapterModule = codexLocal;
