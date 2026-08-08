import { runtimeError } from "../../core/contracts/errors.js";
import type { ModalClientSurface } from "./client-surface.js";
import type { ModalProviderConfig } from "./config.js";

export async function createModalClient(
  creds: { tokenId: string; tokenSecret: string },
  config: ModalProviderConfig,
): Promise<ModalClientSurface> {
  const { ModalClient } = await import("modal");
  const client = new ModalClient({ tokenId: creds.tokenId, tokenSecret: creds.tokenSecret });
  const app = await client.apps.fromName(config.appName, { createIfMissing: true });

  return {
    async create(input) {
      const image = client.images.fromRegistry(input.image);
      const sandbox = await client.sandboxes.create(app, image, {
        workdir: input.workdir,
        timeoutMs: input.timeoutMs,
        blockNetwork: false,
      });
      return { id: sandbox.sandboxId };
    },
    async get(id) {
      try {
        const sandbox = await client.sandboxes.fromId(id);
        return { id: sandbox.sandboxId };
      } catch (error) {
        if ((error as { name?: string })?.name === "NotFoundError") return null;
        throw error;
      }
    },
    async detach(id) {
      const sandbox = await client.sandboxes.fromId(id);
      await Promise.resolve(sandbox.detach()).catch(() => undefined);
    },
    async terminate(id) {
      try {
        const sandbox = await client.sandboxes.fromId(id);
        await sandbox.terminate();
      } catch {
        /* already gone */
      }
    },
    async exec(id, argv, input) {
      const sandbox = await client.sandboxes.fromId(id);
      const proc = await sandbox.exec(argv, {
        mode: "text",
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      });
      const exitCode = await proc.wait();
      const stdout = await proc.stdout.readText();
      const stderr = await proc.stderr.readText();
      return { exitCode: typeof exitCode === "number" ? exitCode : null, stdout, stderr };
    },
    async fsWrite(id, p, content) {
      const sandbox = await client.sandboxes.fromId(id);
      const file = await sandbox.open(p, "w");
      await file.write(content);
      await file.close();
    },
    async fsRead(id, p) {
      const sandbox = await client.sandboxes.fromId(id);
      const file = await sandbox.open(p, "r");
      const bytes = await file.read();
      await file.close();
      return new Uint8Array(bytes);
    },
  };
}

export function modalRuntimeError(message: string): Error {
  return runtimeError("PROVISION_FAILED", message);
}
