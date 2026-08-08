import type { RuntimeProvider, RuntimeProviderManifest } from "../core/contracts/index.js";

export interface ProviderTestContext {
  /** Config passed to createProvider; must be valid per validateConfig. */
  config: unknown;
  credentials?: Record<string, string | undefined>;
  /** Per-test workspace directory (for filesystem tests). */
  workspaceDir: string;
  /** Provider factory to test. */
  createProvider(input: {
    config: unknown;
    credentials?: Record<string, string | undefined>;
  }): Promise<RuntimeProvider>;
}

export interface ProviderContractOptions {
  manifest: RuntimeProviderManifest;
  context: ProviderTestContext;
}

/** Throw helpers for the conformance suite. */
export function expectTrue(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

export function expectResolves(promise: Promise<unknown>, message: string): Promise<void> {
  return promise.then(
    () => undefined,
    (error) => {
      throw new Error(`${message}: ${error instanceof Error ? error.message : String(error)}`);
    },
  );
}

export function assertBytesEqual(actual: Uint8Array, expected: Uint8Array, label = "bytes"): void {
  if (actual.byteLength !== expected.byteLength) {
    throw new Error(`${label}: length mismatch (${actual.byteLength} vs ${expected.byteLength})`);
  }
  for (let i = 0; i < actual.byteLength; i += 1) {
    if (actual[i] !== expected[i]) {
      throw new Error(`${label}: byte mismatch at offset ${i}`);
    }
  }
}
