import type { RuntimeTarget } from "../../../shared/execution-target.js";

/**
 * Novita sandbox driver. STUB for the foundation slice.
 *
 * Real impl: `novita-sandbox` SDK. SDK exposes `autoPause` for lease reuse.
 */

const STUB_MESSAGE =
  "novita sandbox driver is a stub. Set AASPAI_NOVITA_API_KEY and fill in the SDK calls when you need it.";

export const novitaTarget: RuntimeTarget = {
  info: { kind: "sandbox", provider: "novita", label: "Novita", status: "stub" },
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
