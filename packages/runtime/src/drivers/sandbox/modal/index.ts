import type { RuntimeTarget } from "../../../shared/execution-target.js";

/**
 * Modal sandbox driver. STUB for the foundation slice.
 *
 * Real impl: `modal` SDK — `Sandbox.create()` / `sandbox.exec()` /
 * `sandbox.terminate()` / `sandbox.detach()` (no native pause primitive;
 * relies on `sandboxTimeoutMs` + `idleTimeoutMs`).
 */

const STUB_MESSAGE =
  "modal sandbox driver is a stub. Set AASPAI_MODAL_TOKEN_ID + AASPAI_MODAL_TOKEN_SECRET and fill in the SDK calls when you need it.";

export const modalTarget: RuntimeTarget = {
  info: { kind: "sandbox", provider: "modal", label: "Modal", status: "stub" },
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
