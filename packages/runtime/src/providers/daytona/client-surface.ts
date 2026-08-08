import type { RuntimeExecutionRequest } from "../../core/contracts/execution.js";

export interface DaytonaProcessSessionSurface {
  create(sandboxId: string, sessionId: string): Promise<void>;
  execute(
    sandboxId: string,
    sessionId: string,
    input: { command: string; runAsync?: boolean; suppressInputEcho?: boolean },
  ): Promise<{ commandId: string; exitCode?: number; stdout?: string; stderr?: string }>;
  getCommand(
    sandboxId: string,
    sessionId: string,
    commandId: string,
  ): Promise<{ exitCode?: number }>;
  getLogs(
    sandboxId: string,
    sessionId: string,
    commandId: string,
  ): Promise<{
    output?: string;
    stdout?: string;
    stderr?: string;
  }>;
  sendInput(sandboxId: string, sessionId: string, commandId: string, data: string): Promise<void>;
  delete(sandboxId: string, sessionId: string): Promise<void>;
}

export interface DaytonaClientSurface {
  create(input: {
    image?: string;
    snapshot?: string;
    timeoutMs?: number;
    resources?: Record<string, unknown>;
    labels?: Record<string, string>;
    reusable?: boolean;
    target?: string;
    autoStopMinutes?: number;
    autoArchiveMinutes?: number;
    autoDeleteMinutes?: number;
  }): Promise<{ id: string; state?: string }>;
  /** Reconcile an ambiguous create response by its unique acquisition label. */
  findByLabels?(labels: Record<string, string>): Promise<Array<{ id: string; state?: string }>>;
  get(id: string): Promise<{ id: string; state?: string } | null>;
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  delete(id: string): Promise<void>;
  execute(
    id: string,
    input: RuntimeExecutionRequest & { env?: Record<string, string> },
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  fsRead?(id: string, path: string): Promise<Uint8Array>;
  fsWrite?(id: string, path: string, content: Uint8Array): Promise<void>;
  /** Append binary input to a live process/session backing file. */
  fsAppend?(id: string, path: string, content: Uint8Array): Promise<void>;
  /** Native Daytona process sessions used for async identity and live input. */
  processSession?: DaytonaProcessSessionSurface;
  preview?(
    id: string,
    port: number,
    expiresInSeconds?: number,
  ): Promise<{
    url: string;
    token?: string;
    expiresAt?: string;
  }>;
  expirePreview?(id: string, port: number, token: string): Promise<void>;
}
