export * from "@aaspai/contracts/runtime";
export {
  pickTarget,
  createLocalSandboxClient,
} from "./shared/execution-target.js";
export type { RuntimeTarget } from "./shared/execution-target.js";
export {
  LocalSandboxClient,
  type SandboxClient,
  type SandboxDriver,
  type SandboxLease,
} from "./shared/sandbox-client.js";
export {
  prepareRuntimeForExecution,
  restoreRuntimeFromExecution,
  WORKSPACE_ROUNDTRIP_STUB_MESSAGE,
} from "./shared/workspace-roundtrip.js";
export type { PrepareWorkspaceOptions, RestoreWorkspaceOptions } from "./shared/workspace-roundtrip.js";
export {
  CALLBACK_BRIDGE_STUB_MESSAGE,
  startSandboxCallbackBridgeServer,
  createCommandManagedSandboxCallbackBridgeQueueClient,
} from "./shared/callback-bridge.js";
export {
  RUN_LOG_STREAM_STUB_MESSAGE,
  createSandboxRunLogTailFactory,
} from "./shared/run-log-stream.js";
export { SshTransportUnavailableError, SSH_STUB_MESSAGE } from "./shared/ssh.js";
export { buildSandboxNpmInstallCommand } from "./shared/install-command.js";
export {
  preferredShellForSandbox,
  shellCommandArgs,
  shellQuote,
} from "./shared/shell.js";

export { localTarget } from "./drivers/local/index.js";
export { dockerTarget } from "./drivers/docker/index.js";
export { sshTarget } from "./drivers/ssh/index.js";

export { e2bTarget } from "./drivers/sandbox/e2b/index.js";
export { daytonaTarget } from "./drivers/sandbox/daytona/index.js";
export { cloudflareTarget } from "./drivers/sandbox/cloudflare/index.js";
export { modalTarget } from "./drivers/sandbox/modal/index.js";
export { novitaTarget } from "./drivers/sandbox/novita/index.js";
export { exeDevTarget } from "./drivers/sandbox/exe-dev/index.js";
export { kubernetesTarget } from "./drivers/sandbox/kubernetes/index.js";

export { resolveTarget, listRuntimeTargets, RUNTIME_REGISTRY_VERSION } from "./registry.js";
export { listSandboxProviders, type SandboxProviderKey } from "./shared/sandbox-dispatch.js";
