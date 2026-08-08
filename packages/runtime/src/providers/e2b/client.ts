import { runtimeError } from "../../core/contracts/errors.js";
import type { E2bClientSurface } from "./client-surface.js";

export async function createE2bClient(creds: { apiKey: string }): Promise<E2bClientSurface> {
  const { Sandbox } = await import("e2b");
  return {
    async create(input) {
      const sandbox = await Sandbox.create(input.template ?? "base", {
        apiKey: creds.apiKey,
        timeoutMs: input.timeoutMs ?? 3_600_000,
        metadata: { aaspaiProvider: "e2b" },
      });
      return { id: sandbox.sandboxId };
    },
    async get(id) {
      const { Sandbox, SandboxNotFoundError } = await import("e2b");
      try {
        const sandbox = await Sandbox.connect(id, { apiKey: creds.apiKey, timeoutMs: 3_600_000 });
        return { id: sandbox.sandboxId };
      } catch (error) {
        if (error instanceof SandboxNotFoundError) return null;
        throw error;
      }
    },
    async pause(id) {
      const { Sandbox } = await import("e2b");
      const sandbox = await Sandbox.connect(id, { apiKey: creds.apiKey, timeoutMs: 60_000 });
      await sandbox.pause();
    },
    async kill(id) {
      const { Sandbox } = await import("e2b");
      const sandbox = await Sandbox.connect(id, { apiKey: creds.apiKey, timeoutMs: 60_000 }).catch(
        () => null,
      );
      if (sandbox) await sandbox.kill().catch(() => undefined);
    },
    async setTimeout(id, ms) {
      const { Sandbox } = await import("e2b");
      const sandbox = await Sandbox.connect(id, { apiKey: creds.apiKey, timeoutMs: 60_000 }).catch(
        () => null,
      );
      if (sandbox) await sandbox.setTimeout(ms).catch(() => undefined);
    },
    async run(id, script, input) {
      const { Sandbox, CommandExitError, TimeoutError } = await import("e2b");
      const sandbox = await Sandbox.connect(id, { apiKey: creds.apiKey, timeoutMs: 60_000 });
      try {
        const result = (await sandbox.commands.run(script, {
          cwd: input.cwd,
          timeoutMs: input.timeoutMs,
        })) as {
          exitCode: number;
          stdout?: string;
          stderr?: string;
        };
        return {
          exitCode: result.exitCode,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
        };
      } catch (error) {
        if (error instanceof CommandExitError) {
          return {
            exitCode: error.exitCode,
            stdout: error.stdout ?? "",
            stderr: error.stderr ?? "",
          };
        }
        if (error instanceof TimeoutError) {
          return { exitCode: null, stdout: "", stderr: "timed out", timedOut: true };
        }
        throw error;
      }
    },
    async fsWrite(id, p, content) {
      const { Sandbox } = await import("e2b");
      const sandbox = await Sandbox.connect(id, { apiKey: creds.apiKey, timeoutMs: 60_000 });
      await sandbox.files.write(p, Buffer.from(content).toString("utf8"));
    },
    async fsRead(id, p) {
      const { Sandbox } = await import("e2b");
      const sandbox = await Sandbox.connect(id, { apiKey: creds.apiKey, timeoutMs: 60_000 });
      const r = (await sandbox.files.read(p)) as ArrayBuffer | string | Buffer;
      if (typeof r === "string") return new TextEncoder().encode(r);
      if (r instanceof Uint8Array) return r;
      return new Uint8Array(r);
    },
  };
}

export function e2bRuntimeError(message: string): Error {
  return runtimeError("PROVISION_FAILED", message);
}
