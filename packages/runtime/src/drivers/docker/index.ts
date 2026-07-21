import type { RuntimeTarget } from "../../shared/execution-target.js";

/**
 * Docker execution target. STUB for the foundation slice.
 *
 * Real impl will use `dockerode` (or direct `docker` CLI) to create a
 * one-shot container per run, mount the workspace, and `docker exec`
 * the agent CLI inside.
 */
export const dockerTarget: RuntimeTarget = {
  info: { kind: "docker", label: "Docker", status: "stub" },
  async run() {
    throw new Error(
      "dockerTarget is a stub. Use @aaspai/runtime/local for now; the Docker driver lands once you have a use case.",
    );
  },
  async prepareWorkspace() {
    throw new Error("dockerTarget stub: prepareWorkspace not implemented.");
  },
  async restoreWorkspace() {
    throw new Error("dockerTarget stub: restoreWorkspace not implemented.");
  },
};
