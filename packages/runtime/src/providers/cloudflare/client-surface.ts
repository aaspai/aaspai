import type { RuntimeExecutionRequest } from "../../core/contracts/execution.js";

export interface CloudflareBridgeClient {
  acquire(input: {
    remoteCwd: string;
    timeoutMs?: number;
  }): Promise<{ providerLeaseId: string; remoteCwd: string }>;
  resume(providerLeaseId: string): Promise<{ providerLeaseId: string } | null>;
  destroy(providerLeaseId: string): Promise<void>;
  run(input: {
    providerLeaseId: string;
    command: string;
    args: string[];
    env?: Record<string, string>;
    cwd?: string;
    timeoutMs?: number;
    stdin?: string;
  }): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  fs(op: string, payload: Record<string, unknown>): Promise<unknown>;
}

export type { RuntimeExecutionRequest };
