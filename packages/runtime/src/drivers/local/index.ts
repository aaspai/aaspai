import type { RuntimeTarget } from "../../shared/execution-target.js";
import { createLocalSandboxClient } from "../../shared/sandbox-client.js";

/**
 * Local execution target. Runs the agent on the host as a plain
 * subprocess. This is the only target that is "ready" in the
 * foundation slice — every other target is a stub.
 */
export const localTarget: RuntimeTarget = {
  info: { kind: "local", label: "Local", status: "ready" },
  async run(target, options) {
    if (target.kind !== "local") {
      throw new Error(`localTarget cannot run a ${target.kind} target.`);
    }
    const { runProcess } = await import("@aaspai/harness");
    return await runProcess({
      ...options,
      cwd: target.cwd ?? options.cwd ?? process.cwd(),
    });
  },
  async prepareWorkspace(target, { localDir, remoteDir }) {
    if (target.kind !== "local") throw new Error("localTarget only.");
    void localDir;
    void remoteDir;
  },
  async restoreWorkspace(target, { localDir, remoteDir }) {
    if (target.kind !== "local") throw new Error("localTarget only.");
    void localDir;
    void remoteDir;
  },
};

export { createLocalSandboxClient };
