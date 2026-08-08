import type { RuntimeExecutionRequest } from "../../core/contracts/execution.js";

export interface KubeClientSurface {
  create(input: {
    name: string;
    namespace: string;
    image: string;
    workingDir: string;
  }): Promise<{ podName: string; namespace: string }>;
  get(name: string, namespace: string): Promise<{ podName: string; namespace: string } | null>;
  destroy(name: string, namespace: string): Promise<void>;
  exec(input: {
    podName: string;
    namespace: string;
    command: string;
    args: string[];
    stdin?: string;
  }): Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>;
}

export type { RuntimeExecutionRequest };
