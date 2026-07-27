import type { ProviderCapabilities } from "@aaspai/contracts/capabilities";
import type { RuntimeTarget } from "../../../shared/execution-target.js";
import { ExeDevSandboxDriver } from "../../../shared/providers/exe-dev-driver.js";
import { createSdkSandboxTarget } from "../../../shared/sdk-sandbox-target.js";

/**
 * exe.dev SSH Visitor. Real impl uses the exe.dev REST API:
 *   - `POST https://exe.dev/exec` with `{ name, image, command }` for `acquire`
 *   - All commands run via `ssh exedev@<host>` over the operator's
 *     registered SSH key
 *   - `DELETE /exec/<name>` for `release()` / `destroy()`
 *
 * Set `EXE_API_KEY` to enable. The SSH client uses the host's
 * registered key (operator runs `ssh exe.dev` once to register).
 */
const EXE_DEV_CAPABILITIES: ProviderCapabilities = {
  execute: true,
  streaming: true,
  cancellation: true,
  timeout: true,
  workspaceIsolation: true,
  restore: true,
  resume: true,
  artifacts: true,
  billing: "api",
};

export const exeDevTarget: RuntimeTarget = createSdkSandboxTarget({
  driver: new ExeDevSandboxDriver({
    image: "ubuntu-24.04",
    command: "/bin/bash",
  }),
  providerKey: "exe_dev",
  label: "exe.dev SSH visitor",
  capabilities: EXE_DEV_CAPABILITIES,
});
