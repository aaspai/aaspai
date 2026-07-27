import type { ProviderCapabilities } from "@aaspai/contracts/capabilities";
import type { RuntimeTarget } from "../../../shared/execution-target.js";
import { ModalSandboxDriver } from "../../../shared/providers/modal-driver.js";
import { createSdkSandboxTarget } from "../../../shared/sdk-sandbox-target.js";

/**
 * Modal Sandbox. Real impl uses the `modal` SDK:
 *   - `ModalClient({ tokenId, tokenSecret }).sandboxes.create(app, image, params)` for `acquire`
 *   - `sandbox.exec(["bash", "-lc", script])` for `client.run` (Modal's exec
 *     takes a pre-parsed argv; we wrap in `bash -lc` to honor login profiles)
 *   - `sandbox.open(path, "r"|"w")` for FS methods
 *   - `sandbox.terminate()` for `release()` / `destroy()`
 *
 * Set `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` to enable.
 */
const MODAL_CAPABILITIES: ProviderCapabilities = {
  execute: true,
  streaming: true,
  cancellation: true,
  timeout: true,
  workspaceIsolation: true,
  restore: true,
  resume: true,
  artifacts: true,
  billing: "metered_api",
};

export const modalTarget: RuntimeTarget = createSdkSandboxTarget({
  driver: new ModalSandboxDriver({
    image: "debian:bookworm-slim",
    sandboxTimeoutMs: 3_600_000,
  }),
  providerKey: "modal",
  label: "Modal sandbox",
  capabilities: MODAL_CAPABILITIES,
});
