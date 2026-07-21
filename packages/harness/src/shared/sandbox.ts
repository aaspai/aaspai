/**
 * Sandbox client interface for adapters. STUB for the foundation slice.
 *
 * The real `SandboxClient` (6 methods: makeDir / writeFile / readFile /
 * listFiles / remove / run) is provided by `@aaspai/runtime` once that
 * package lands. Adapters that want to run inside a cloud sandbox
 * depend on the runtime, not on this stub.
 *
 * The contract surface is re-exported here so adapters can stay
 * transport-agnostic: they import the type from `@aaspai/harness` and
 * the runtime provides the implementation at call time.
 */

export type { SandboxClient } from "@aaspai/contracts/runtime";

export const SANDBOX_STUB_MESSAGE =
  "Sandbox transport is provided by @aaspai/runtime. Import it from there, not from @aaspai/harness/shared/sandbox.";

export class SandboxTransportUnavailableError extends Error {
  readonly code = "AASPAI_SANDBOX_UNAVAILABLE";
  constructor() {
    super(SANDBOX_STUB_MESSAGE);
    this.name = "SandboxTransportUnavailableError";
  }
}
