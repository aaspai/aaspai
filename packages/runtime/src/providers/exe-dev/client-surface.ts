import type { RuntimeExecutionRequest } from "../../core/contracts/execution.js";

export interface ExeDevClientSurface {
  create(input: {
    name: string;
    image: string;
    command: string;
  }): Promise<{ name: string; sshDest: string }>;
  get(name: string): Promise<{ name: string; sshDest: string } | null>;
  destroy(name: string): Promise<void>;
  runSsh(input: {
    sshDest: string;
    remoteCommand: string;
    timeoutMs?: number;
    identity?: string;
  }): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  scp(input: {
    sshDest: string;
    localPath?: string;
    remotePath: string;
    direction: "to" | "from";
    identity?: string;
  }): Promise<Uint8Array | undefined>;
}

export type { RuntimeExecutionRequest };
