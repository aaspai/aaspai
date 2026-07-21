import type { RuntimeTarget } from "../../shared/execution-target.js";

/**
 * SSH execution target. STUB for the foundation slice.
 *
 * Real impl will use `node-ssh` (or the `ssh` CLI directly) to round-trip
 * the local workspace to the remote host, then `exec` the agent CLI.
 */
export const sshTarget: RuntimeTarget = {
  info: { kind: "ssh", label: "SSH", status: "stub" },
  async run() {
    throw new Error(
      "sshTarget is a stub. Use @aaspai/runtime/local for now; the SSH driver lands once you have a use case.",
    );
  },
  async prepareWorkspace() {
    throw new Error("sshTarget stub: prepareWorkspace not implemented.");
  },
  async restoreWorkspace() {
    throw new Error("sshTarget stub: restoreWorkspace not implemented.");
  },
};
