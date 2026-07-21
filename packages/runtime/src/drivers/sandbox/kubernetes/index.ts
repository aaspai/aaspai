import type { RuntimeTarget } from "../../../shared/execution-target.js";

/**
 * Kubernetes sandbox driver. STUB for the foundation slice.
 *
 * Real impl: `@kubernetes/client-node` driving one of two backends:
 *   - `sandbox-cr`: `agents.x-k8s.io/v1alpha1` Sandbox CR (long-lived pod,
 *     multi-command exec) — the default
 *   - `job`: `batch/v1` Job (one-shot, no multi-command) — the fallback
 *
 * The plugin keeps both backends behind a `SandboxOrchestrator` interface
 * so adding new backends (e.g. `knative`, `virtualcluster`) does not
 * touch the `plugin.ts` lifecycle.
 */

const STUB_MESSAGE =
  "kubernetes sandbox driver is a stub. Provide a kubeconfig and pick sandbox-cr or job when you need it.";

export const kubernetesTarget: RuntimeTarget = {
  info: { kind: "sandbox", provider: "kubernetes", label: "Kubernetes", status: "stub" },
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
