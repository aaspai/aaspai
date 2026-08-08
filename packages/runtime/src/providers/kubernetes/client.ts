import { spawn } from "node:child_process";
import { runtimeError } from "../../core/contracts/errors.js";
import type { KubeClientSurface } from "./client-surface.js";
import type { KubernetesProviderConfig } from "./config.js";

export async function createKubectlClient(
  config: KubernetesProviderConfig,
): Promise<KubeClientSurface> {
  const kubectl = config.kubectl ?? "kubectl";
  const namespace = config.namespace ?? "default";

  function execRaw(input: {
    command: string;
    args: string[];
    stdin?: string;
  }): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const args = ["exec", "-i", "-n", namespace, input.command, "--", ...input.args];
      const child = spawn(kubectl, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      if (input.stdin !== undefined) child.stdin?.end(input.stdin);
      else child.stdin?.end();
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (b: Buffer) => stdout.push(b));
      child.stderr.on("data", (b: Buffer) => stderr.push(b));
      child.on("close", (code) =>
        resolve({
          exitCode: code,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        }),
      );
      child.on("error", reject);
    });
  }

  return {
    async create(input) {
      const podSpec = {
        apiVersion: "v1",
        kind: "Pod",
        metadata: {
          name: input.name,
          namespace: input.namespace,
          labels: { "aaspai.io/provider": "kubernetes", "aaspai.io/lease": input.name },
        },
        spec: {
          containers: [
            {
              name: "sandbox",
              image: input.image,
              command: ["tail", "-f", "/dev/null"],
              workingDir: input.workingDir,
            },
          ],
          restartPolicy: "Never",
        },
      };
      await new Promise<void>((resolve, reject) => {
        const child = spawn(kubectl, ["apply", "-f", "-"], {
          stdio: ["pipe", "ignore", "pipe"],
          windowsHide: true,
        });
        child.stdin?.end(JSON.stringify(podSpec));
        const stderr: Buffer[] = [];
        child.stderr.on("data", (b: Buffer) => stderr.push(b));
        child.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error(Buffer.concat(stderr).toString("utf8"))),
        );
        child.on("error", reject);
      });
      return { podName: input.name, namespace: input.namespace };
    },
    async get(name, ns) {
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(kubectl, ["get", "pod", name, "-n", ns, "-o", "name"], {
            stdio: "ignore",
            windowsHide: true,
          });
          child.on("close", (code) =>
            code === 0 ? resolve() : reject(new Error(`pod not found: ${name}`)),
          );
          child.on("error", reject);
        });
        return { podName: name, namespace: ns };
      } catch {
        return null;
      }
    },
    async destroy(name, ns) {
      const child = spawn(kubectl, ["delete", "pod", name, "-n", ns, "--ignore-not-found"], {
        stdio: "ignore",
        windowsHide: true,
      });
      await new Promise<void>((resolve) => child.on("close", () => resolve()));
    },
    async exec(input) {
      return await execRaw({
        command: input.podName,
        args: [input.command, ...input.args],
        stdin: input.stdin,
      });
    },
  };
}

export function kubernetesRuntimeError(message: string): Error {
  return runtimeError("PROVISION_FAILED", message);
}
