import type {
  AdapterInfo,
  AdapterType,
  ProviderCapabilities,
  ServerAdapterModule,
} from "@aaspai/contracts";
import { opencodeServer } from "@aaspai/opencode";

/**
 * Production harness discovery.
 *
 * The foundation deliberately has one native adapter today: OpenCode's
 * authenticated server driver. CLI/ACP adapters from the migration period are
 * not registered here, so a caller cannot accidentally select an unverified
 * transport through the production registry.
 */
const PRODUCTION_ADAPTERS: Readonly<Record<"opencode_local", ServerAdapterModule>> = Object.freeze({
  opencode_local: opencodeServer,
});

export const PRODUCTION_ADAPTER_TYPES = ["opencode_local"] as const;
export const ADAPTER_REGISTRY_VERSION = 2 as const;

export function listProductionAdapters(): AdapterInfo[] {
  return PRODUCTION_ADAPTER_TYPES.map((type) => adapterInfo(type));
}

export function getProductionAdapter(type: (typeof PRODUCTION_ADAPTER_TYPES)[number]) {
  return PRODUCTION_ADAPTERS[type];
}

/** Capability metadata is derived from the adapter manifest, never guessed. */
export function capabilitiesFor(module: ServerAdapterModule): ProviderCapabilities {
  const supports = module.describe?.();
  const description = supports && !(supports instanceof Promise) ? supports : undefined;
  if (module.info.status !== "ready") {
    return {
      execute: false,
      streaming: false,
      cancellation: false,
      timeout: false,
      workspaceIsolation: false,
      restore: false,
      resume: false,
      artifacts: false,
    };
  }
  return {
    execute: true,
    streaming: module.info.transport === "local_subprocess",
    cancellation: description?.supportsCancel ?? false,
    timeout: module.info.transport === "local_subprocess",
    workspaceIsolation: false,
    restore: false,
    resume: description?.supportsResume ?? false,
    artifacts: false,
  };
}

/**
 * Migration callers may still ask for the generic lookup function, but only a
 * production adapter can resolve. Unknown and legacy adapter names fail closed.
 */
export function getAdapter(type: AdapterType): ServerAdapterModule {
  const adapter = PRODUCTION_ADAPTERS[type as keyof typeof PRODUCTION_ADAPTERS];
  if (!adapter) throw new Error(`Adapter is not enabled for production: ${String(type)}`);
  return adapter;
}

export function listAdapters(): AdapterInfo[] {
  return listProductionAdapters();
}

export function getAdapterCapabilities(type: AdapterType): ProviderCapabilities {
  return capabilitiesFor(getAdapter(type));
}

export function isAdapterReady(type: AdapterType): boolean {
  try {
    return getAdapter(type).info.status === "ready";
  } catch {
    return false;
  }
}

function adapterInfo(type: (typeof PRODUCTION_ADAPTER_TYPES)[number]): AdapterInfo {
  const adapter = PRODUCTION_ADAPTERS[type];
  return { ...adapter.info, capabilities: capabilitiesFor(adapter) };
}
