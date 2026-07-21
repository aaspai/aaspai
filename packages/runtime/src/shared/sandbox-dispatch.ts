import type { RuntimeTarget } from "./execution-target.js";
import { e2bTarget } from "../drivers/sandbox/e2b/index.js";
import { daytonaTarget } from "../drivers/sandbox/daytona/index.js";
import { cloudflareTarget } from "../drivers/sandbox/cloudflare/index.js";
import { modalTarget } from "../drivers/sandbox/modal/index.js";
import { novitaTarget } from "../drivers/sandbox/novita/index.js";
import { exeDevTarget } from "../drivers/sandbox/exe-dev/index.js";
import { kubernetesTarget } from "../drivers/sandbox/kubernetes/index.js";

/**
 * Dispatch table for sandbox execution targets. One stub per provider
 * for the foundation slice — e2b has a real skeleton, the rest throw
 * "not yet implemented" with a clear message.
 */
const SANDBOX_TARGETS = {
  e2b: e2bTarget,
  daytona: daytonaTarget,
  cloudflare: cloudflareTarget,
  modal: modalTarget,
  novita: novitaTarget,
  exe_dev: exeDevTarget,
  kubernetes: kubernetesTarget,
} as const;

export type SandboxProviderKey = keyof typeof SANDBOX_TARGETS;

export function pickSandboxTarget(provider: SandboxProviderKey): RuntimeTarget {
  return SANDBOX_TARGETS[provider];
}

export function listSandboxProviders(): SandboxProviderKey[] {
  return Object.keys(SANDBOX_TARGETS) as SandboxProviderKey[];
}
