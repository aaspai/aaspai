import type {
  RuntimeProvider,
  RuntimeProviderDescriptor,
  RuntimeProviderFactory,
  RuntimeProviderManifest,
} from "./core/contracts/index.js";
import type { RuntimeClock, RuntimeCredentialSet, RuntimeLogger } from "./core/contracts/lease.js";

export interface RuntimeRegistry {
  list(): RuntimeProviderDescriptor[];
  get(type: string): RuntimeProviderDescriptor | undefined;
  has(type: string): boolean;
  /** Lazily load and construct a provider for a type. */
  createProvider(
    type: string,
    input: {
      config: unknown;
      credentials?: RuntimeCredentialSet;
      logger?: RuntimeLogger;
      clock?: RuntimeClock;
      trace?: { executionId?: string; sessionId?: string };
    },
  ): Promise<RuntimeProvider>;
}

interface RegistryEntry {
  manifest: RuntimeProviderManifest;
  load: () => Promise<{ createProvider: RuntimeProviderFactory }>;
}

export function createRuntimeRegistry(entries: Record<string, RegistryEntry>): RuntimeRegistry {
  return {
    list(): RuntimeProviderDescriptor[] {
      return Object.values(entries);
    },
    get(type: string): RuntimeProviderDescriptor | undefined {
      const entry = entries[type];
      return entry
        ? ({ manifest: entry.manifest, load: entry.load } satisfies RuntimeProviderDescriptor)
        : undefined;
    },
    has(type: string): boolean {
      return type in entries;
    },
    async createProvider(type, input) {
      const entry = entries[type];
      if (!entry) throw new Error(`unknown runtime provider: ${type}`);
      if (entry.manifest.status !== "ready") {
        throw new Error(`runtime provider is not enabled for production: ${type}`);
      }
      const { createProvider } = await entry.load();
      const provider = await createProvider({
        config: input.config,
        credentials: input.credentials,
        logger: input.logger,
        clock: input.clock,
        trace: input.trace,
      });
      const validation = await provider.validateConfig(input.config);
      if (!validation.ok) {
        throw new Error(`invalid ${type} runtime config: ${validation.errors.join("; ")}`);
      }
      return provider;
    },
  };
}
