import type { RuntimeTarget } from "../../../shared/execution-target.js";

/**
 * exe.dev sandbox driver. STUB for the foundation slice.
 *
 * Real impl: HTTPS API at `https://exe.dev/exec` for VM lifecycle
 * (`new`/`ls`/`rm` with a 29s API timeout) + SSH from host to `*.exe.xyz`
 * for command exec. exe.dev has no real pause — `reuseLease` just
 * keeps the VM alive.
 */

const STUB_MESSAGE =
  "exe-dev sandbox driver is a stub. Configure SSH access to *.exe.xyz and fill in the SDK calls when you need it.";

export const exeDevTarget: RuntimeTarget = {
  info: { kind: "sandbox", provider: "exe_dev", label: "exe.dev", status: "stub" },
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
