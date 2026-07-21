import type { RuntimeTarget } from "../../../shared/execution-target.js";

/**
 * e2b sandbox driver. SKELETON for the foundation slice.
 *
 * Real impl (once you have an `E2B_API_KEY`):
 *   1. `import { Sandbox } from "e2b"`
 *   2. `const sandbox = await Sandbox.create(template, { apiKey, timeoutMs })`
 *   3. Build a `SandboxClient` over the e2b SDK:
 *        - `makeDir`  → `sandbox.commands.run("mkdir -p ...")`
 *        - `writeFile` → `sandbox.files.write(path, content)`
 *        - `readFile` → `sandbox.files.read(path)`
 *        - `listFiles` → `await sandbox.files.list(path)`
 *        - `remove`   → `sandbox.commands.run("rm -rf ...")`
 *        - `run`      → `sandbox.commands.run(command, { cwd, timeoutMs, envs })`
 *   4. `sandbox.pause()` for `reuseLease`, `sandbox.kill()` otherwise.
 *
 * The skeleton below keeps the dispatch surface and the lease contract
 * stable so swapping the body in is a one-file change.
 */

const STUB_MESSAGE =
  "e2b sandbox driver is a skeleton. Set AASPAI_E2B_API_KEY and fill in the SDK calls when you need it.";

export const e2bTarget: RuntimeTarget = {
  info: { kind: "sandbox", provider: "e2b", label: "e2b", status: "stub" },
  async run() {
    throw new Error(STUB_MESSAGE);
  },
  async prepareWorkspace() {
    throw new Error(`${STUB_MESSAGE} (prepareWorkspace)`);
  },
  async restoreWorkspace() {
    throw new Error(`${STUB_MESSAGE} (restoreWorkspace)`);
  },
};
