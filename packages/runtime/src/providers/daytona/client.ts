import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runtimeError } from "../../core/contracts/errors.js";
import { assertValidEnvMap, shellQuote } from "../../core/shell/environment.js";
import type { DaytonaClientSurface } from "./client-surface.js";

/**
 * Adapter over `@daytonaio/sdk` exposing the minimal surface the V2
 * provider needs. Loaded lazily so the module imports cleanly without
 * an API key configured.
 */
export async function createDaytonaClient(creds: {
  apiKey: string;
  apiUrl?: string;
}): Promise<DaytonaClientSurface> {
  const { Daytona, DaytonaNotFoundError } = await import("@daytonaio/sdk");
  const client = new Daytona(
    creds.apiUrl ? { apiKey: creds.apiKey, apiUrl: creds.apiUrl } : { apiKey: creds.apiKey },
  );

  const toSeconds = (ms: number): number => Math.max(1, Math.ceil(ms / 1000));

  return {
    async create(input) {
      const params: Record<string, unknown> = {
        labels: input.labels ?? {},
        // V2 leases are resumable. The old driver used ephemeral sandboxes,
        // which made a serialized lease meaningless after a worker restart.
        ephemeral: input.reusable === false,
      };
      if (input.image) params.image = input.image;
      if (input.snapshot) params.snapshot = input.snapshot;
      if (input.resources) params.resources = input.resources;
      if (input.target) params.target = input.target;
      // Daytona's SDK intervals are expressed in minutes (despite the
      // timeout options elsewhere in the SDK using seconds).
      if (input.autoStopMinutes !== undefined) params.autoStopInterval = input.autoStopMinutes;
      if (input.autoArchiveMinutes !== undefined)
        params.autoArchiveInterval = input.autoArchiveMinutes;
      if (input.autoDeleteMinutes !== undefined)
        params.autoDeleteInterval = input.autoDeleteMinutes;
      const sandbox = await client.create(params as never, {
        timeout: toSeconds(input.timeoutMs ?? 300_000),
      });
      return { id: sandbox.id, state: sandbox.state };
    },
    async findByLabels(labels) {
      const result = await client.list(labels, 1, 100);
      return result.items.map((sandbox) => ({ id: sandbox.id, state: sandbox.state }));
    },
    async get(id) {
      try {
        const sandbox = await client.get(id);
        return { id: sandbox.id, state: sandbox.state };
      } catch (error) {
        if (error instanceof DaytonaNotFoundError) return null;
        throw error;
      }
    },
    async start(id) {
      const sandbox = await client.get(id);
      await sandbox.start(120);
    },
    async stop(id) {
      const sandbox = await client.get(id);
      await sandbox.stop(120);
    },
    async delete(id) {
      try {
        const sandbox = await client.get(id);
        await sandbox.delete(120);
      } catch (error) {
        if (error instanceof DaytonaNotFoundError) return;
        throw error;
      }
    },
    async execute(id, input) {
      const sandbox = await client.get(id);
      assertValidEnvMap(input.env);
      const env = {
        HOME: "/root",
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        LANG: "C.UTF-8",
        ...(input.env ?? {}),
      };
      // Provider internals sometimes pass a complete, already-quoted shell
      // command (for example `mkdir -p '/tmp/run'`), while user commands
      // retain the safer command/argument split. Preserve the former when no
      // args are present and quote the latter when args are supplied.
      const invocation =
        input.args.length > 0
          ? [shellQuote(input.command), ...input.args.map(shellQuote)].join(" ")
          : input.command;
      const command = `cd ${shellQuote(input.cwd ?? "/")} && ${invocation}`;
      const result = await sandbox.process.executeCommand(
        command,
        input.cwd,
        env,
        toSeconds(input.timeoutMs ?? 60_000),
      );
      return {
        exitCode: result.exitCode,
        stdout: result.result ?? result.artifacts?.stdout ?? "",
        stderr: "",
      };
    },
    async fsRead(id, remotePath) {
      const sandbox = await client.get(id);
      return new Uint8Array(await sandbox.fs.downloadFile(remotePath));
    },
    async fsWrite(id, remotePath, content) {
      const sandbox = await client.get(id);
      const stagingDir = await mkdtemp(path.join(tmpdir(), "aaspai-daytona-upload-"));
      const stagingPath = path.join(stagingDir, "payload");
      try {
        await writeFile(stagingPath, content);
        await sandbox.fs.uploadFile(stagingPath, remotePath);
      } finally {
        await rm(stagingDir, { recursive: true, force: true });
      }
    },
    async fsAppend(id, remotePath, content) {
      const sandbox = await client.get(id);
      const encoded = Buffer.from(content).toString("base64");
      const command = `printf '%s' ${shellQuote(encoded)} | base64 -d >> ${shellQuote(remotePath)}`;
      const result = await sandbox.process.executeCommand(command, "/", undefined, 30);
      if (result.exitCode !== 0) {
        throw runtimeError("FILESYSTEM_FAILED", result.result ?? "failed to append process input");
      }
    },
    processSession: {
      async create(id, sessionId) {
        const sandbox = await client.get(id);
        await sandbox.process.createSession(sessionId);
      },
      async execute(id, sessionId, input) {
        const sandbox = await client.get(id);
        const result = await sandbox.process.executeSessionCommand(sessionId, {
          command: input.command,
          runAsync: input.runAsync ?? true,
          suppressInputEcho: input.suppressInputEcho ?? true,
        });
        return {
          commandId: result.cmdId,
          ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
          ...(result.stdout ? { stdout: result.stdout } : {}),
          ...(result.stderr ? { stderr: result.stderr } : {}),
        };
      },
      async getCommand(id, sessionId, commandId) {
        const sandbox = await client.get(id);
        const command = await sandbox.process.getSessionCommand(sessionId, commandId);
        return command.exitCode === undefined ? {} : { exitCode: command.exitCode };
      },
      async getLogs(id, sessionId, commandId) {
        const sandbox = await client.get(id);
        return await sandbox.process.getSessionCommandLogs(sessionId, commandId);
      },
      async sendInput(id, sessionId, commandId, data) {
        const sandbox = await client.get(id);
        await sandbox.process.sendSessionCommandInput(sessionId, commandId, data);
      },
      async delete(id, sessionId) {
        const sandbox = await client.get(id);
        await sandbox.process.deleteSession(sessionId);
      },
    },
    async preview(id, port, expiresInSeconds = 60) {
      const sandbox = await client.get(id);
      const preview = await sandbox.getSignedPreviewUrl(port, expiresInSeconds);
      return {
        url: preview.url,
        token: preview.token,
      };
    },
    async expirePreview(id, port, token) {
      const sandbox = await client.get(id);
      await sandbox.expireSignedPreviewUrl(port, token);
    },
  };
}

export function daytonaRuntimeError(message: string): Error {
  return runtimeError("PROVISION_FAILED", message);
}
