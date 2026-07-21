import type { RuntimeTarget } from "../../../shared/execution-target.js";

/**
 * Daytona sandbox driver. STUB for the foundation slice.
 *
 * Real impl: `@daytonaio/sdk` — `Sandbox.create()` / `sandbox.process.execute()` /
 * `sandbox.fs.upload()` / `sandbox.fs.download()`. Has snapshot + image modes
 * and quota-safety defaults (autoStopInterval / autoArchiveInterval / autoDeleteInterval).
 */

const STUB_MESSAGE =
  "daytona sandbox driver is a stub. Set AASPAI_DAYTONA_API_KEY and fill in the SDK calls when you need it.";

export const daytonaTarget: RuntimeTarget = {
  info: { kind: "sandbox", provider: "daytona", label: "Daytona", status: "stub" },
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
