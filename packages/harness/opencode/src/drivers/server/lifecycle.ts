import { randomBytes } from "node:crypto";
import {
  OPENCODE_COMPATIBILITY_VERSION,
  type OpenCodeHealth,
  OpenCodeServerClient,
} from "./client.js";

interface RuntimeExecutionRequest {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  inheritEnv?: boolean;
}

interface RuntimeProcessHandle {
  wait(): Promise<unknown>;
  cancel(reason?: string): Promise<void>;
}

interface RuntimeEndpointHandle {
  url: string;
  headers?: Record<string, string>;
  close?(): Promise<void>;
}

export interface OpenCodeServerRuntime {
  startExecution(
    request: RuntimeExecutionRequest,
    hooks?: {
      onStdout?(chunk: Uint8Array): Promise<void> | void;
      onStderr?(chunk: Uint8Array): Promise<void> | void;
    },
  ): Promise<RuntimeProcessHandle>;
  exposeEndpoint?(options: {
    port: number;
    protocol?: "http" | "https" | "tcp";
  }): Promise<RuntimeEndpointHandle>;
}

export interface ManagedOpenCodeServer {
  readonly endpoint: string;
  readonly username: string;
  readonly password: string;
  readonly process: RuntimeProcessHandle;
  readonly client: OpenCodeServerClient;
  readonly health: OpenCodeHealth;
  stop(reason?: string): Promise<void>;
}

/** Start one authenticated server inside an injected runtime boundary. */
export async function startManagedOpenCodeServer(options: {
  runtime: OpenCodeServerRuntime;
  command?: string;
  commandArgs?: string[];
  cwd: string;
  configEnv?: Record<string, string>;
  expectedVersion?: string | RegExp;
  startupTimeoutMs?: number;
  port?: number;
  hostname?: string;
  exposeEndpoint?: (options: {
    port: number;
    protocol?: "http" | "https" | "tcp";
  }) => Promise<RuntimeEndpointHandle>;
}): Promise<ManagedOpenCodeServer> {
  const username = "aaspai";
  const password = randomBytes(32).toString("base64url");
  // OpenCode 1.18 treats port 0 as "use the default" (4096), which makes
  // concurrent remote servers collide. Pick an ephemeral high port unless
  // the caller supplied one explicitly.
  const requestedPort = options.port ?? 40_000 + (randomBytes(2).readUInt16BE(0) % 10_000);
  const hostname = options.hostname ?? (options.exposeEndpoint ? "0.0.0.0" : "127.0.0.1");
  let output = "";
  const processHandle = await options.runtime.startExecution(
    {
      command: options.command ?? "opencode",
      args: [
        ...(options.commandArgs ?? []),
        "serve",
        "--hostname",
        hostname,
        "--port",
        String(requestedPort),
      ],
      cwd: options.cwd,
      env: {
        ...(options.configEnv ?? {}),
        OPENCODE_SERVER_USERNAME: username,
        OPENCODE_SERVER_PASSWORD: password,
      },
      inheritEnv: true,
    },
    {
      onStdout: (chunk) => {
        output += new TextDecoder().decode(chunk);
        if (output.length > 64 * 1024) output = output.slice(-64 * 1024);
      },
      onStderr: (chunk) => {
        output += new TextDecoder().decode(chunk);
        if (output.length > 64 * 1024) output = output.slice(-64 * 1024);
      },
    },
  );

  const deadline = Date.now() + (options.startupTimeoutMs ?? 10_000);
  let client: OpenCodeServerClient | undefined;
  let health: OpenCodeHealth | undefined;
  let resolvedEndpoint: string | undefined;
  let endpointHandle: RuntimeEndpointHandle | undefined;
  try {
    while (Date.now() < deadline) {
      const match = /https?:\/\/[^\s/]+(?::\d+)?/i.exec(output);
      if (!match?.[0]) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      resolvedEndpoint = match[0].replace(/[),.]+$/, "");
      const parsedEndpoint = new URL(resolvedEndpoint);
      if (options.exposeEndpoint && parsedEndpoint.port && !endpointHandle) {
        endpointHandle = await options.exposeEndpoint({
          port: Number(parsedEndpoint.port),
          protocol: parsedEndpoint.protocol === "https:" ? "https" : "http",
        });
      }
      client = new OpenCodeServerClient({
        baseUrl: endpointHandle?.url ?? resolvedEndpoint,
        username,
        password,
        headers: endpointHandle?.headers,
        expectedVersion: options.expectedVersion ?? OPENCODE_COMPATIBILITY_VERSION,
      });
      try {
        health = await client.health();
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!client || !health || !resolvedEndpoint)
      throw new Error(`OpenCode server did not become healthy: ${output.slice(-1_024)}`);
    return {
      endpoint: resolvedEndpoint,
      username,
      password,
      process: processHandle,
      client,
      health,
      async stop(reason) {
        await processHandle.cancel(reason ?? "opencode_server_stop");
        await processHandle.wait();
        await endpointHandle?.close?.().catch(() => undefined);
      },
    };
  } catch (error) {
    await processHandle.cancel("opencode_server_start_failed").catch(() => undefined);
    await processHandle.wait().catch(() => undefined);
    await endpointHandle?.close?.().catch(() => undefined);
    throw error;
  }
}
