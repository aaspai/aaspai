import type { ProviderCapabilities } from "@aaspai/contracts/capabilities";
import type { RuntimeTarget } from "../../../shared/execution-target.js";
import { E2bSandboxDriver } from "../../../shared/providers/e2b-driver.js";
import { createSdkSandboxTarget } from "../../../shared/sdk-sandbox-target.js";

/**
 * E2B Cloud Sandbox. Real impl uses the official `e2b` SDK:
 *   - `Sandbox.create(template, { apiKey, timeoutMs })` for `acquire`
 *   - `sandbox.commands.run(...)` for `client.run`
 *   - `sandbox.pause()` for `release({ reuseLease: true })`
 *   - `sandbox.kill()` for `release()` / `destroy()`
 *
 * Set `E2B_API_KEY` (or pass `apiKey` in the execution target metadata)
 * to enable. The provider throws a clear "API key required" error if
 * neither is set — the test runner treats that as `skipped: needs E2B_API_KEY`.
 */
const E2B_CAPABILITIES: ProviderCapabilities = {
  execute: true,
  streaming: true,
  cancellation: true,
  timeout: true,
  workspaceIsolation: true,
  restore: false,
  resume: true,
  artifacts: true,
  billing: "metered_api",
};

export const e2bTarget: RuntimeTarget = createSdkSandboxTarget({
  driver: new E2bSandboxDriver({ template: "base", timeoutMs: 3_600_000 }),
  providerKey: "e2b",
  label: "e2b (Firecracker microVM)",
  capabilities: E2B_CAPABILITIES,
});
