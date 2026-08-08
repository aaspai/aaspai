/**
 * `@aaspai/runtime` is the production Runtime V2 facade.
 *
 * The facade intentionally exposes only the provider contract, the stateless
 * controller, the lazy production registry, and the two providers that pass
 * the current release gate (Local and Daytona). Provider SDKs and lifecycle
 * details stay behind the provider subpaths.
 */
export * from "./core/index.js";
export {
  createRuntimeRegistryFromFactories,
  defaultRuntimeRegistry,
} from "./default-registry.js";
export {
  createDaytonaProvider,
  createDaytonaProviderFromConfig,
  type DaytonaProviderConfig,
  daytonaConfigSchema,
  daytonaManifest,
  normalizeDaytonaConfig,
} from "./providers/daytona/index.js";
export {
  createLocalProvider,
  createLocalProviderFromConfig,
  LOCAL_LEASE_ID,
  type LocalProviderConfig,
  type LocalProviderOptions,
  localConfigSchema,
  localManifest,
} from "./providers/local/index.js";
export { createRuntimeRegistry, type RuntimeRegistry } from "./registry.js";
