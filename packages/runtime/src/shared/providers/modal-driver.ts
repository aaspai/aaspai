import { ModalClient } from "modal";
import type { Sandbox as ModalSandbox, App, Image as ModalImage } from "modal";
import type { RunProcessOptions, RunProcessResult } from "@aaspai/contracts/runtime";
import type { SandboxClient, SandboxLease } from "../sandbox-client.js";
import {
  SdkSandboxDriver,
  buildLoginShellScript,
  shellQuote,
  toRunResult,
} from "../sdk-sandbox-driver.js";

/**
 * Resolve Modal credentials (tokenId + tokenSecret).
 */
function resolveCredentials(input: { tokenId?: string | null; tokenSecret?: string | null }): {
  tokenId: string;
  tokenSecret: string;
} {
  const tokenId = input.tokenId?.trim() || process.env.MODAL_TOKEN_ID?.trim() || "";
  const tokenSecret = input.tokenSecret?.trim() || process.env.MODAL_TOKEN_SECRET?.trim() || "";
  if (!tokenId && !tokenSecret) {
    throw new Error("modal sandbox requires MODAL_TOKEN_ID + MODAL_TOKEN_SECRET env vars");
  }
  if (!tokenId || !tokenSecret) {
    throw new Error("modal sandbox requires BOTH MODAL_TOKEN_ID and MODAL_TOKEN_SECRET env vars");
  }
  return { tokenId, tokenSecret };
}

/**
 * Real Modal-backed `SandboxDriver`. Uses the `modal` SDK:
 *   - `ModalClient({ tokenId, tokenSecret }).sandboxes.create(app, image, params)` for `acquire`
 *   - `client.sandboxes.fromId(providerLeaseId)` for `resume`
 *   - `sandbox.exec(["sh", "-lc", script])` for `client.run` (Modal's exec takes
 *     a pre-parsed argv, so we wrap the user's command in `sh -lc`)
 *   - `sandbox.open(path, "r")` / `sandbox.open(path, "w")` for FS methods
 *   - `sandbox.terminate()` for `release()` / `destroy()`
 */
export class ModalSandboxDriver extends SdkSandboxDriver<ModalSandbox> {
  private readonly modalClient: ModalClient;
  private readonly appName: string;
  private readonly imageName: string;
  private readonly workdir: string;
  private readonly sandboxTimeoutMs: number;

  constructor(options: {
    tokenId?: string | null;
    tokenSecret?: string | null;
    appName?: string;
    image?: string;
    workdir?: string;
    sandboxTimeoutMs?: number;
  } = {}) {
    super("modal");
    // Defer the credential check to `acquire` so the module loads
    // cleanly even when MODAL_TOKEN_ID/SECRET are not set.
    this.modalClient = new ModalClient({
      tokenId: options.tokenId ?? process.env.MODAL_TOKEN_ID ?? "",
      tokenSecret: options.tokenSecret ?? process.env.MODAL_TOKEN_SECRET ?? "",
    });
    this.appName = options.appName ?? process.env.MODAL_APP_NAME ?? "aaspai-modal";
    this.imageName = options.image ?? "debian:bookworm-slim";
    this.workdir = options.workdir ?? "/workspace/aaspai";
    this.sandboxTimeoutMs = options.sandboxTimeoutMs ?? 3_600_000;
  }

  private getCredentials(): { tokenId: string; tokenSecret: string } {
    return resolveCredentials({});
  }

  private async resolveApp(): Promise<App> {
    return await this.modalClient.apps.fromName(this.appName, { createIfMissing: true });
  }

  protected override async createSandbox(input: {
    remoteCwd: string;
    timeoutMs?: number;
  }): Promise<{ raw: ModalSandbox; remoteCwd: string; metadata: Record<string, unknown> }> {
    this.getCredentials(); // throws here if creds are missing
    const app = await this.resolveApp();
    const image: ModalImage = this.modalClient.images.fromRegistry(this.imageName);
    const sandbox = await this.modalClient.sandboxes.create(app, image, {
      workdir: this.workdir,
      timeoutMs: input.timeoutMs ?? this.sandboxTimeoutMs,
      blockNetwork: false,
    });
    const remoteCwd = input.remoteCwd ?? this.workdir;
    // Ensure workspace exists
    await sandbox.exec(["sh", "-lc", `mkdir -p ${shellQuote(remoteCwd)}`]);
    return {
      raw: sandbox,
      remoteCwd,
      metadata: {
        sandboxId: sandbox.sandboxId,
        appName: this.appName,
        image: this.imageName,
        remoteCwd,
      },
    };
  }

  protected override async reconnect(providerLeaseId: string): Promise<ModalSandbox | null> {
    try {
      return await this.modalClient.sandboxes.fromId(providerLeaseId);
    } catch (error) {
      // Modal throws NotFoundError on a missing sandbox
      if ((error as { name?: string }).name === "NotFoundError") return null;
      throw error;
    }
  }

  protected override async destroySandbox(raw: ModalSandbox): Promise<void> {
    await raw.terminate();
  }

  protected override leaseId(raw: ModalSandbox): string {
    return raw.sandboxId;
  }

  protected override buildClient(raw: ModalSandbox, lease: SandboxLease): SandboxClient {
    const remoteCwd = lease.remoteCwd;
    const execCommand = async (options: RunProcessOptions): Promise<RunProcessResult> => {
      const startedAt = new Date();
      // Modal's exec takes a pre-parsed argv, so we wrap the user's
      // command in `bash -lc` so login profiles and PATH prepends
      // are honored (nvm, npm-globals, etc.).
      const script = buildLoginShellScript({
        command: options.command,
        ...(options.args ? { args: options.args } : {}),
        ...(options.env ? { env: options.env } : {}),
      });
      const proc = await raw.exec(["bash", "-lc", script], {
        mode: "text",
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
      const exitCode = await proc.wait();
      const stdout = await proc.stdout.readText();
      const stderr = await proc.stderr.readText();
      return toRunResult({
        exitCode: typeof exitCode === "number" ? exitCode : null,
        stdout,
        stderr,
        startedAt,
      });
    };

    return {
      async makeDir(remotePath, options) {
        await raw.exec([
          "sh",
          "-lc",
          `mkdir ${options?.recursive === false ? "" : "-p"} ${shellQuote(remotePath)}`,
        ]);
      },
      async writeFile(remotePath, content) {
        const text = typeof content === "string" ? content : Buffer.from(content).toString("utf8");
        const file = await raw.open(remotePath, "w");
        await file.write(new TextEncoder().encode(text));
        await file.close();
      },
      async readFile(remotePath) {
        const file = await raw.open(remotePath, "r");
        const bytes = await file.read();
        await file.close();
        return Buffer.from(bytes);
      },
      async listFiles(remotePath) {
        const proc = await raw.exec([
          "sh",
          "-lc",
          `cd ${shellQuote(remotePath)} && find . -mindepth 1 -maxdepth 1 -printf '%f|%s|%y\\n'`,
        ], { mode: "text" });
        await proc.wait();
        const text = await proc.stdout.readText();
        return text
          .trim()
          .split("\n")
          .filter((l) => l.length > 0)
          .map((line) => {
            const [name, sizeStr, typeChar] = line.split("|");
            return {
              name: name ?? "",
              size: Number.parseInt(sizeStr ?? "0", 10),
              isDir: typeChar === "d",
            };
          });
      },
      async remove(remotePath, options) {
        await raw.exec([
          "sh",
          "-lc",
          `rm ${options?.recursive === false ? "-f" : "-rf"} ${shellQuote(remotePath)}`,
        ]);
      },
      run: execCommand,
    };
  }
}
