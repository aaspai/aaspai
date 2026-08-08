import { runtimeError } from "../../core/contracts/errors.js";
import type { CloudflareBridgeClient } from "./client-surface.js";

export async function createCloudflareBridgeClient(creds: {
  bridgeUrl: string;
  authToken?: string;
}): Promise<CloudflareBridgeClient> {
  async function call(path: string, body: Record<string, unknown>): Promise<unknown> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (creds.authToken) headers.Authorization = `Bearer ${creds.authToken}`;
    const res = await fetch(`${creds.bridgeUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw runtimeError("PROVIDER_UNAVAILABLE", `cloudflare bridge ${res.status}: ${text}`);
    }
    return await res.json();
  }

  return {
    async acquire(input) {
      const data = (await call("/api/aaspai-sandbox/v1/acquire", {
        remoteCwd: input.remoteCwd,
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      })) as { providerLeaseId: string; remoteCwd: string };
      return data;
    },
    async resume(providerLeaseId) {
      try {
        const data = (await call("/api/aaspai-sandbox/v1/resume", { providerLeaseId })) as {
          providerLeaseId: string;
        };
        return data;
      } catch (error) {
        if (/404|409/i.test((error as Error)?.message ?? String(error))) return null;
        throw error;
      }
    },
    async destroy(providerLeaseId) {
      await call("/api/aaspai-sandbox/v1/destroy", { providerLeaseId }).catch(() => undefined);
    },
    async run(input) {
      const data = (await call("/api/aaspai-sandbox/v1/run", {
        providerLeaseId: input.providerLeaseId,
        command: input.command,
        args: input.args,
        env: input.env ?? {},
        cwd: input.cwd,
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      })) as { exitCode: number | null; stdout: string; stderr: string };
      return data;
    },
    async fs(op, payload) {
      return await call(`/api/aaspai-sandbox/v1/fs/${op}`, payload);
    },
  };
}

export function cloudflareRuntimeError(message: string): Error {
  return runtimeError("PROVISION_FAILED", message);
}
