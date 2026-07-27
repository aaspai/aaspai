import type { ProviderCapabilities } from "@aaspai/contracts/capabilities";
import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import type { RuntimeTarget } from "../../../shared/execution-target.js";
import { KubernetesSandboxDriver } from "../../../shared/providers/kubernetes-driver.js";
import { createSdkSandboxTarget } from "../../../shared/sdk-sandbox-target.js";

/**
 * Kubernetes Pod Sandbox. Real impl uses `@kubernetes/client-node`:
 *   - `k8sApi.createNamespacedPod(...)` for `acquire`
 *   - `k8sApi.deleteNamespacedPod(...)` for `release()` / `destroy()`
 *   - `kubectl exec` for the 6-method `SandboxClient`
 *
 * KubeConfig is loaded from `KUBECONFIG` env var, the default
 * `~/.kube/config`, or in-cluster config. Set `AASPAI_K8S_NAMESPACE`
 * to override the default namespace.
 */
const KUBERNETES_CAPABILITIES: ProviderCapabilities = {
  execute: true,
  streaming: true,
  cancellation: true,
  timeout: true,
  workspaceIsolation: true,
  restore: true,
  resume: true,
  artifacts: true,
  billing: "subscription",
};

function loadKubeConfig(): KubeConfig | null {
  if (!process.env.KUBECONFIG && !process.env.AASPAI_K8S_ENABLED) {
    return null;
  }
  const kc = new KubeConfig();
  if (process.env.KUBECONFIG) {
    kc.loadFromFile(process.env.KUBECONFIG);
  } else {
    kc.loadFromDefault();
  }
  return kc;
}

const kubeConfig = loadKubeConfig();
const k8sApi = kubeConfig ? kubeConfig.makeApiClient(CoreV1Api) : null;

if (!k8sApi) {
  // Module-level skip — see run-real.ts. We throw on construction
  // in `acquire` rather than here so the export works for typing.
  void KubernetesSandboxDriver;
}

export const kubernetesTarget: RuntimeTarget = k8sApi
  ? createSdkSandboxTarget({
      driver: new KubernetesSandboxDriver({
        k8sApi,
        namespace: process.env.AASPAI_K8S_NAMESPACE ?? "default",
        image: process.env.AASPAI_K8S_IMAGE ?? "alpine:3.20",
        timeoutMs: 60_000,
      }),
      providerKey: "kubernetes",
      label: "Kubernetes pod",
      capabilities: KUBERNETES_CAPABILITIES,
    })
  : // A placeholder target that throws on first use. This keeps the
    // export shape consistent while letting the test runner report
    // "skipped: needs KUBECONFIG" cleanly.
    {
      info: {
        kind: "sandbox" as const,
        provider: "kubernetes" as never,
        label: "Kubernetes pod",
        status: "stub" as const,
        capabilities: KUBERNETES_CAPABILITIES,
      },
      async run() {
        throw new Error(
          "kubernetes sandbox requires KUBECONFIG env var or AASPAI_K8S_ENABLED=1 (no in-cluster config detected)",
        );
      },
      async prepareWorkspace() {
        throw new Error("kubernetes sandbox: stub");
      },
      async restoreWorkspace() {
        throw new Error("kubernetes sandbox: stub");
      },
    };
