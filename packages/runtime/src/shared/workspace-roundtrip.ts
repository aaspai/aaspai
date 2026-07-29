import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxClient } from "./sandbox-client.js";
import { shellQuote } from "./sdk-sandbox-driver.js";

export interface PrepareWorkspaceOptions {
  client: SandboxClient;
  localDir: string;
  remoteDir: string;
  onProgress?: (update: { transferredBytes: number; totalBytes?: number }) => void;
}

export interface RestoreWorkspaceOptions extends PrepareWorkspaceOptions {}

const REMOTE_ARCHIVE = "/tmp/aaspai-workspace.tar.gz";
const REMOTE_PATCH = "/tmp/aaspai-workspace.patch";
const BASE_TAG = "aaspai-runtime-base";

/**
 * Copy the assigned worktree into a sandbox and create a private Git baseline.
 * The host worktree's `.git` file is intentionally excluded because it points
 * back to host-only worktree metadata.
 */
export async function prepareRuntimeForExecution(options: PrepareWorkspaceOptions): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "aaspai-runtime-"));
  const archivePath = join(tempDir, "workspace.tar.gz");
  try {
    await runLocal(
      "tar",
      [
        "-czf",
        "workspace.tar.gz",
        "--exclude=.git",
        "--exclude=node_modules",
        "-C",
        options.localDir,
        ".",
      ],
      tempDir,
    );
    const archive = await readFile(archivePath);
    options.onProgress?.({ transferredBytes: archive.length, totalBytes: archive.length });
    // ponytail: archive buffering is simple and bounded by the assigned worktree;
    // switch SandboxClient to streams if large-repository measurements require it.
    await options.client.writeFile(REMOTE_ARCHIVE, archive);
    await runRemote(
      options.client,
      [
        "set -eu",
        `mkdir -p ${shellQuote(options.remoteDir)}`,
        `find ${shellQuote(options.remoteDir)} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +`,
        `tar --no-same-owner -xzf ${shellQuote(REMOTE_ARCHIVE)} -C ${shellQuote(options.remoteDir)}`,
        `rm -f ${shellQuote(REMOTE_ARCHIVE)}`,
        `cd ${shellQuote(options.remoteDir)}`,
        "git init -q",
        "git config user.name aaspai-runtime",
        "git config user.email runtime@aaspai.local",
        "git add -A",
        "git commit --allow-empty -qm aaspai-runtime-base",
        `git tag -f ${BASE_TAG}`,
      ].join(" && "),
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Restore every tracked addition, modification, and deletion relative to the
 * remote baseline. Ignored build output stays in the disposable sandbox.
 */
export async function restoreRuntimeFromExecution(options: RestoreWorkspaceOptions): Promise<void> {
  await runRemote(
    options.client,
    [
      "set -eu",
      `cd ${shellQuote(options.remoteDir)}`,
      "git add -A",
      `git diff --cached --binary --full-index ${BASE_TAG} > ${shellQuote(REMOTE_PATCH)}`,
    ].join(" && "),
  );
  const patch = await options.client.readFile(REMOTE_PATCH);
  options.onProgress?.({ transferredBytes: patch.length, totalBytes: patch.length });
  if (patch.length === 0) {
    await options.client.remove(REMOTE_PATCH, { recursive: false }).catch(() => undefined);
    return;
  }

  const tempDir = await mkdtemp(join(tmpdir(), "aaspai-runtime-"));
  const patchPath = join(tempDir, "workspace.patch");
  try {
    await writeFile(patchPath, patch);
    await runLocal(
      "git",
      [
        `--git-dir=${join(tempDir, "no-repository")}`,
        "apply",
        "--no-index",
        "--binary",
        "--whitespace=nowarn",
        patchPath,
      ],
      options.localDir,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    await options.client.remove(REMOTE_PATCH, { recursive: false }).catch(() => undefined);
  }
}

async function runRemote(client: SandboxClient, script: string): Promise<void> {
  const result = await client.run({ command: "sh", args: ["-lc", script] });
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || "remote workspace command failed",
    );
  }
}

async function runLocal(command: string, args: string[], cwd?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `${command} failed`));
    });
  });
}
