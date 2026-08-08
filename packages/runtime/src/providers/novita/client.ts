import { runtimeError } from "../../core/contracts/errors.js";
import type { NovitaClientSurface } from "./client-surface.js";

export async function createNovitaClient(creds: { apiKey: string }): Promise<NovitaClientSurface> {
  const { Sandbox } = await import("novita-sandbox");
  const opts = (timeoutMs: number) => ({
    apiKey: creds.apiKey,
    timeoutMs,
    requestTimeoutMs: 30_000,
  });

  return {
    async create(input) {
      const sandbox = await Sandbox.create(
        input.template ?? "shellx-aliyun",
        opts(input.timeoutMs ?? 300_000),
      );
      return { id: sandbox.sandboxId };
    },
    async get(id) {
      try {
        const sandbox = await Sandbox.connect(id, opts(60_000));
        return { id: sandbox.sandboxId };
      } catch (error) {
        const name = (error as { name?: string })?.name ?? "";
        if (name === "SandboxNotFoundError" || name === "NotFoundError") return null;
        throw error;
      }
    },
    async pause(id) {
      const sandbox = await Sandbox.connect(id, opts(60_000));
      try {
        await (
          sandbox as unknown as { betaPause: (o: { requestTimeoutMs: number }) => Promise<void> }
        ).betaPause({ requestTimeoutMs: 30_000 });
      } catch {
        await sandbox.kill({ requestTimeoutMs: 30_000 }).catch(() => undefined);
      }
    },
    async kill(id) {
      try {
        const sandbox = await Sandbox.connect(id, opts(60_000));
        await sandbox.kill({ requestTimeoutMs: 30_000 });
      } catch {
        /* already gone */
      }
    },
    async setTimeout(id, ms) {
      const sandbox = await Sandbox.connect(id, opts(60_000)).catch(() => null);
      if (sandbox)
        await sandbox.setTimeout(ms, { requestTimeoutMs: 30_000 }).catch(() => undefined);
    },
    async run(id, script, input) {
      const sandbox = await Sandbox.connect(id, opts(60_000));
      const result = await sandbox.commands.run(script, {
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
      });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    },
    async fsWrite(id, p, content) {
      const sandbox = await Sandbox.connect(id, opts(60_000));
      await (
        sandbox as unknown as { files: { write: (p: string, c: string) => Promise<unknown> } }
      ).files.write(p, new TextDecoder().decode(content));
    },
    async fsRead(id, p) {
      const sandbox = await Sandbox.connect(id, opts(60_000));
      const text = await (
        sandbox as unknown as { files: { read: (p: string) => Promise<string> } }
      ).files.read(p);
      return new TextEncoder().encode(text);
    },
  };
}

export function novitaRuntimeError(message: string): Error {
  return runtimeError("PROVISION_FAILED", message);
}
