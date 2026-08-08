import type { RuntimeProviderFactory, RuntimeProviderManifest } from "./core/contracts/index.js";
import { daytonaManifest } from "./providers/daytona/manifest.js";
import { localManifest } from "./providers/local/manifest.js";
import { createRuntimeRegistry, type RuntimeRegistry } from "./registry.js";

interface RegistryEntry {
  manifest: RuntimeProviderManifest;
  load(): Promise<{ createProvider: RuntimeProviderFactory }>;
}

export function defaultRuntimeRegistry(): RuntimeRegistry {
  // The default facade is intentionally small. Providers without a passing
  // V2 conformance and credentialed release gate stay available through
  // explicit experimental manifests, but cannot be discovered by production
  // callers.
  const entries: Record<string, RegistryEntry> = {
    local: {
      manifest: localManifest,
      async load() {
        const mod = await import("./providers/local/index.js");
        return {
          createProvider: (input) =>
            mod.createLocalProviderFromConfig(input.config, { clock: input.clock }),
        };
      },
    },
    daytona: {
      manifest: daytonaManifest,
      async load() {
        const mod = await import("./providers/daytona/index.js");
        return {
          createProvider: (input) =>
            mod.createDaytonaProviderFromConfig(input.config, {
              credentials: input.credentials,
              clock: input.clock,
            }),
        };
      },
    },
  };
  return createRuntimeRegistry(entries);
}

export function createRuntimeRegistryFromFactories(
  factories: Record<string, RegistryEntry>,
): RuntimeRegistry {
  return createRuntimeRegistry(factories);
}
