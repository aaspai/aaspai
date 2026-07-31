import type { ProviderCapabilities } from "@aaspai/contracts/capabilities";
import type { RuntimeTarget } from "../../../shared/execution-target.js";
import { DaytonaSandboxDriver } from "../../../shared/providers/daytona-driver.js";
import { createSdkSandboxTarget } from "../../../shared/sdk-sandbox-target.js";

/**
 * Daytona Cloud Sandbox. Real impl uses the `@daytonaio/sdk`:
 *   - `new Daytona({ apiKey }).create({ image, cpu, memory, timeout })` for `acquire`
 *   - `sandbox.process.executeCommand(...)` for `client.run`
 *   - `sandbox.fs.upload/download/...` for the FS methods
 *   - `sandbox.stop()` for `release({ reuseLease: true })`
 *   - `sandbox.delete()` for `release()` / `destroy()`
 *
 * Set `DAYTONA_API_KEY` (or pass `apiKey` in the execution target metadata)
 * to enable. The test runner treats "API key required" as `skipped`.
 */
const DAYTONA_CAPABILITIES: ProviderCapabilities = {
  execute: true,
  streaming: true,
  cancellation: true,
  timeout: true,
  workspaceIsolation: true,
  restore: true,
  resume: true,
  artifacts: false,
  billing: "metered_api",
};

export const daytonaTarget: RuntimeTarget = createSdkSandboxTarget({
  driver: new DaytonaSandboxDriver({
    snapshot: "aaspai-opencode-1-18-5-v3",
    image: "node:22-bookworm-slim",
    timeoutMs: 120_000,
  }),
  providerKey: "daytona",
  label: "Daytona (development environment)",
  capabilities: DAYTONA_CAPABILITIES,
});
