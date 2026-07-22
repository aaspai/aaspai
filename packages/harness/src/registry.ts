import type { AdapterInfo, AdapterType, ServerAdapterModule } from "@aaspai/contracts/harness";
import { claudeLocal } from "./drivers/claude-local/index.js";
import { codexLocal } from "./drivers/codex-local/index.js";
import { cursorCloud } from "./drivers/cursor-cloud/index.js";
import { cursorLocal } from "./drivers/cursor-local/index.js";
import { dryRunLocal } from "./drivers/dry-run-local/index.js";
import { hermesGateway } from "./drivers/hermes-gateway/index.js";
import { openclawGateway } from "./drivers/openclaw-gateway/index.js";
import { opencodeCli } from "./drivers/opencode-cli/index.js";
import { opencodeLocal } from "./drivers/opencode-local/index.js";

/**
 * The full adapter registry. Maps every known `AdapterType` to its
 * `ServerAdapterModule`. Adding a new adapter:
 * 1. Create `src/drivers/<name>/{config,parse,execute,format,index}.ts`
 * 2. Add the module import + entry below
 * 3. Add the new type to `ADAPTER_TYPE_VALUES` in
 *    `packages/contracts/src/harness.ts`
 * 4. Bump `HARNESS_PROTOCOL_VERSION` if the change is breaking
 */
const ADAPTERS: Readonly<Record<AdapterType, ServerAdapterModule>> = Object.freeze({
  claude_local: claudeLocal,
  codex_local: codexLocal,
  cursor_local: cursorLocal,
  cursor_cloud: cursorCloud,
  openclaw_gateway: openclawGateway,
  hermes_gateway: hermesGateway,
  dry_run_local: dryRunLocal,
  opencode_local: opencodeLocal,
  opencode_cli: opencodeCli,
});

export function listAdapters(): AdapterInfo[] {
  return Object.values(ADAPTERS).map((m) => m.info);
}

export function getAdapter(type: AdapterType): ServerAdapterModule {
  const adapter = ADAPTERS[type];
  if (!adapter) {
    throw new Error(`Unknown adapter type: ${String(type)}`);
  }
  return adapter;
}

export function isAdapterReady(type: AdapterType): boolean {
  return getAdapter(type).info.status === "ready";
}

export const ADAPTER_REGISTRY_VERSION = 1 as const;
