import type { CoreV1Api, V1Pod, V1PodSpec } from "@kubernetes/client-node";
import { randomUUID } from "node:crypto";
import type { RunProcessOptions, RunProcessResult } from "@aaspai/contracts/runtime";
import type { SandboxClient, SandboxLease } from "../sandbox-client.js";
import { SdkSandboxDriver, shellQuote, toRunResult } from "../sdk-sandbox-driver.js";

/**
 * Real Kubernetes-backed `SandboxDriver`. Uses `@kubernetes/client-node`:
 *   - `k8sApi.createNamespacedPod(...)` for `acquire`
 *   - `k8sApi.readNamespacedPod` poll for `recover` / `resume`
 *   - `k8sApi.connectGetNamespacedPodExec(...)` over WebSocket for `client.run`
 *   - `k8sApi.deleteNamespacedPod(...)` for `release()` / `destroy()`
 *
 * Each sandbox is a Pod in a per-tenant namespace. The Pod runs a
 * minimal image (default `alpine`) with `tail -f /dev/null` as the
 * entrypoint so the container stays alive between commands.
 */
export class KubernetesSandboxDriver extends SdkSandboxDriver<{ podName: string; namespace: string }> {
  private readonly k8sApi: CoreV1Api;
  private readonly namespace: string;
  private readonly image: string;
  private readonly timeoutMs: number;

  constructor(options: {
    k8sApi: CoreV1Api;
    namespace?: string;
    image?: string;
    timeoutMs?: number;
  }) {
    super("kubernetes");
    this.k8sApi = options.k8sApi;
    this.namespace = options.namespace ?? "default";
    this.image = options.image ?? "alpine:3.20";
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  protected override async createSandbox(input: {
    remoteCwd: string;
    timeoutMs?: number;
  }): Promise<{ raw: { podName: string; namespace: string }; remoteCwd: string; metadata: Record<string, unknown> }> {
    const podName = `aaspai-${randomUUID().slice(0, 8).toLowerCase()}`;
    const podSpec: V1PodSpec = {
      containers: [
        {
          name: "sandbox",
          image: this.image,
          command: ["tail", "-f", "/dev/null"],
          workingDir: input.remoteCwd,
        },
      ],
      restartPolicy: "Never",
    };
    const podManifest: V1Pod = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: podName,
        namespace: this.namespace,
        labels: {
          "aaspai.io/provider": "kubernetes",
          "aaspai.io/lease": podName,
        },
      },
      spec: podSpec,
    };
    await this.k8sApi.createNamespacedPod({
      namespace: this.namespace,
      body: podManifest,
    });

    // Wait for the pod to be Running (best-effort with a 60s budget)
    const deadline = Date.now() + (input.timeoutMs ?? this.timeoutMs);
    while (Date.now() < deadline) {
      const read = await this.k8sApi.readNamespacedPod({ name: podName, namespace: this.namespace });
      const phase = read.status?.phase;
      if (phase === "Running") break;
      if (phase === "Failed" || phase === "Succeeded") {
        throw new Error(`kubernetes sandbox pod ${podName} reached terminal phase ${phase}`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    return {
      raw: { podName, namespace: this.namespace },
      remoteCwd: input.remoteCwd,
      metadata: {
        podName,
        namespace: this.namespace,
        image: this.image,
        remoteCwd: input.remoteCwd,
      },
    };
  }

  protected override async reconnect(
    _providerLeaseId: string,
  ): Promise<{ podName: string; namespace: string } | null> {
    // The providerLeaseId IS the podName; we look it up
    try {
      const pod = await this.k8sApi.readNamespacedPod({
        name: _providerLeaseId,
        namespace: this.namespace,
      });
      if (pod.status?.phase !== "Running") return null;
      return { podName: _providerLeaseId, namespace: this.namespace };
    } catch {
      return null;
    }
  }

  protected override async destroySandbox(raw: { podName: string; namespace: string }): Promise<void> {
    await this.k8sApi.deleteNamespacedPod({ name: raw.podName, namespace: raw.namespace });
  }

  protected override leaseId(raw: { podName: string; namespace: string }): string {
    return raw.podName;
  }

  protected override buildClient(
    raw: { podName: string; namespace: string },
    lease: SandboxLease,
  ): SandboxClient {
    const execCommand = async (options: RunProcessOptions): Promise<RunProcessResult> => {
      const startedAt = new Date();
      // k8s exec WebSocket: stdin/stdout/stderr channels
      // We use `k8sApi.connectGetNamespacedPodExec` which is WebSocket-based.
      // For simplicity we shell out to a single command via `kubectl exec` —
      // most test environments have kubectl; if not, this method throws.
      return await execViaKubectl(raw.podName, raw.namespace, options, lease.remoteCwd, startedAt);
    };

    return {
      async makeDir(remotePath, options) {
        await execViaKubectl(
          raw.podName,
          raw.namespace,
          {
            command: "mkdir",
            args: [options?.recursive === false ? "" : "-p", remotePath].filter(Boolean),
          },
          lease.remoteCwd,
          new Date(),
        );
      },
      async writeFile(remotePath, content) {
        const text = typeof content === "string" ? content : Buffer.from(content).toString("utf8");
        // Use kubectl exec with a shell redirect: `tee > /path`
        await execViaKubectl(
          raw.podName,
          raw.namespace,
          {
            command: "sh",
            args: ["-c", `mkdir -p ${shellQuote(remotePath.split("/").slice(0, -1).join("/") || ".")} && cat > ${shellQuote(remotePath)}`],
            stdin: text,
          },
          lease.remoteCwd,
          new Date(),
        );
      },
      async readFile(remotePath) {
        const r = await execViaKubectl(
          raw.podName,
          raw.namespace,
          { command: "cat", args: [remotePath] },
          lease.remoteCwd,
          new Date(),
        );
        return Buffer.from(r.stdout, "utf8");
      },
      async listFiles(remotePath) {
        const r = await execViaKubectl(
          raw.podName,
          raw.namespace,
          {
            command: "sh",
            args: ["-c", `cd ${shellQuote(remotePath)} && find . -mindepth 1 -maxdepth 1 -printf '%f|%s|%y\\n'`],
          },
          lease.remoteCwd,
          new Date(),
        );
        return r.stdout
          .trim()
          .split("\n")
          .filter((l) => l.length > 0)
          .map((line) => {
            const [name, sizeStr, typeChar] = line.split("|");
            return {
              name: name ?? "",
              size: Number.parseInt(sizeStr ?? "0", 10),
              isDir: typeChar === "d",
            };
          });
      },
      async remove(remotePath, options) {
        await execViaKubectl(
          raw.podName,
          raw.namespace,
          {
            command: "rm",
            args: [options?.recursive === false ? "-f" : "-rf", remotePath],
          },
          lease.remoteCwd,
          new Date(),
        );
      },
      run: execCommand,
    };
  }
}

async function execViaKubectl(
  podName: string,
  namespace: string,
  options: RunProcessOptions,
  cwd: string,
  startedAt: Date,
): Promise<RunProcessResult> {
  const { spawn } = await import("node:child_process");
  // Note: `kubectl exec` argv uses a single `--` to separate the kubectl
  // flags from the in-pod command. The pod's `workingDir` is set in the
  // pod spec (see createSandbox above), so the container starts in the
  // right directory; we don't need a `cd` wrap here.
  const args = ["exec", "-i", "-n", namespace, podName, "--", options.command, ...(options.args ?? [])];
  void cwd;
  return await new Promise<RunProcessResult>((resolve) => {
    const child = spawn("kubectl", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    if (options.stdin !== undefined) {
      child.stdin?.end(options.stdin);
    } else {
      child.stdin?.end();
    }
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => stdoutChunks.push(b));
    child.stderr.on("data", (b: Buffer) => stderrChunks.push(b));
    child.on("close", (code, signal) => {
      resolve(
        toRunResult({
          exitCode: code,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          signal: signal ?? undefined,
          startedAt,
        }),
      );
    });
  });
}

