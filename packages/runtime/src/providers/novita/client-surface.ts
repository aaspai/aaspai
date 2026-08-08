import type { RuntimeExecutionRequest } from "../../core/contracts/execution.js";

export interface NovitaClientSurface {
  create(input: { template?: string; timeoutMs?: number }): Promise<{ id: string }>;
  get(id: string): Promise<{ id: string } | null>;
  pause(id: string): Promise<void>;
  kill(id: string): Promise<void>;
  setTimeout(id: string, ms: number): Promise<void>;
  run(
    id: string,
    script: string,
    input: { cwd: string; timeoutMs: number },
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  fsWrite?(id: string, path: string, content: Uint8Array): Promise<void>;
  fsRead?(id: string, path: string): Promise<Uint8Array>;
}

export type { RuntimeExecutionRequest };
