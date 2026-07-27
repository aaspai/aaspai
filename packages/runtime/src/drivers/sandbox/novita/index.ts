import type { ProviderCapabilities } from "@aaspai/contracts/capabilities";
import type { RuntimeTarget } from "../../../shared/execution-target.js";
import { NovitaSandboxDriver } from "../../../shared/providers/novita-driver.js";
import { createSdkSandboxTarget } from "../../../shared/sdk-sandbox-target.js";

/**
 * Novita GPU Sandbox. Real impl uses the `novita-sandbox` SDK:
 *   - `Sandbox.create(template, opts)` for `acquire`
 *   - `Sandbox.connect(sandboxId, opts)` for `resume`
 *   - `sandbox.commands.run(...)` for `client.run`
 *   - `sandbox.betaPause()` for `release({ reuseLease: true })`
 *   - `sandbox.kill()` for `release()` / `destroy()`
 *
 * Set `NOVITA_API_KEY` to enable.
 */
const NOVITA_CAPABILITIES: ProviderCapabilities = {
  execute: true,
  streaming: true,
  cancellation: true,
  timeout: true,
  workspaceIsolation: true,
  restore: false,
  resume: false,
  artifacts: true,
  billing: "metered_api",
};

export const novitaTarget: RuntimeTarget = createSdkSandboxTarget({
  driver: new NovitaSandboxDriver({ template: "shellx-aliyun", timeoutMs: 300_000 }),
  providerKey: "novita",
  label: "Novita GPU instance",
  capabilities: NOVITA_CAPABILITIES,
});
