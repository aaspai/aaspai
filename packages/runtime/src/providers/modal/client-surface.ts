import type { RuntimeExecutionRequest } from "../../core/contracts/execution.js";

export interface ModalClientSurface {
  create(input: { image: string; workdir: string; timeoutMs: number }): Promise<{ id: string }>;
  get(id: string): Promise<{ id: string } | null>;
  detach(id: string): Promise<void>;
  terminate(id: string): Promise<void>;
  exec(
    id: string,
    argv: string[],
    input: { timeoutMs?: number },
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  fsWrite?(id: string, path: string, content: Uint8Array): Promise<void>;
  fsRead?(id: string, path: string): Promise<Uint8Array>;
}

export type { RuntimeExecutionRequest };
