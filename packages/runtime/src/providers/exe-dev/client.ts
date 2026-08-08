import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runtimeError } from "../../core/contracts/errors.js";
import { shellQuote } from "../../core/shell/quote.js";
import type { ExeDevClientSurface } from "./client-surface.js";

const DEFAULT_SETUP_SCRIPT = `set -e
. /etc/profile
apt-get update -y
apt-get install -y curl ca-certificates git
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
`;

function parseVmRecord(value: unknown): { name: string; sshDest: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const name =
    typeof record.vm_name === "string"
      ? record.vm_name
      : typeof record.name === "string"
        ? record.name
        : typeof record.vmName === "string"
          ? record.vmName
          : null;
  const sshDest =
    typeof record.ssh_dest === "string"
      ? record.ssh_dest
      : typeof record.sshDest === "string"
        ? record.sshDest
        : name
          ? `${name}.exe.xyz`
          : null;
  if (!name || !sshDest) return null;
  return { name, sshDest };
}

export async function createExeDevClient(creds: { apiKey: string }): Promise<ExeDevClientSurface> {
  const apiUrl = process.env.EXE_API_URL?.trim() || "https://exe.dev/exec";

  async function lifecycleCommand(command: string, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 60_000));
    timer.unref();
    let response: Response;
    try {
      response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${creds.apiKey}`,
          "Content-Type": "text/plain; charset=utf-8",
        },
        body: command,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const body = await response.text();
    if (!response.ok) {
      throw runtimeError("PROVISION_FAILED", `exe.dev API ${response.status}: ${body}`);
    }
    const trimmed = body.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return body;
    }
  }

  return {
    async create(input) {
      const parts = [
        "new",
        "--json",
        "--no-email",
        `--name=${shellQuote(input.name)}`,
        `--image=${shellQuote(input.image)}`,
        `--command=${shellQuote(input.command)}`,
        `--setup-script=${shellQuote(DEFAULT_SETUP_SCRIPT)}`,
      ];
      const response = await lifecycleCommand(parts.join(" "), 60_000);
      const vm = parseVmRecord(response);
      if (vm) return vm;
      // Fall back to ls lookup.
      const listed = (await lifecycleCommand(`ls --json ${shellQuote(input.name)}`, 30_000)) as
        | { vms?: unknown[] }
        | unknown[]
        | null;
      const list: unknown[] = Array.isArray(listed)
        ? listed
        : Array.isArray((listed as { vms?: unknown[] } | null)?.vms)
          ? (listed as { vms: unknown[] }).vms
          : listed
            ? [listed]
            : [];
      for (const candidate of list) {
        const parsed = parseVmRecord(candidate);
        if (parsed && (parsed.name === input.name || parsed.sshDest === input.name)) return parsed;
      }
      throw runtimeError(
        "PROVISION_FAILED",
        `exe.dev did not return VM metadata for ${input.name}`,
      );
    },
    async get(name) {
      const response = await lifecycleCommand(`ls --json ${shellQuote(name)}`, 30_000);
      const list: unknown[] = Array.isArray(response)
        ? response
        : ((response as { vms?: unknown[] } | null)?.vms ?? [response].filter(Boolean));
      for (const candidate of list) {
        const parsed = parseVmRecord(candidate);
        if (parsed && (parsed.name === name || parsed.sshDest === name)) return parsed;
      }
      return null;
    },
    async destroy(name) {
      await lifecycleCommand(`rm --json ${shellQuote(name)}`, 30_000).catch(() => undefined);
    },
    async runSsh(input) {
      const sshArgs = [
        "-p",
        "22",
        "-o",
        "BatchMode=yes",
        "-T",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ConnectTimeout=15",
      ];
      if (input.identity) sshArgs.push("-i", input.identity, "-o", "IdentitiesOnly=yes");
      sshArgs.push(input.sshDest, input.remoteCommand);
      return await new Promise((resolve, reject) => {
        const child = spawn("ssh", sshArgs, {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let timeoutHandle: NodeJS.Timeout | undefined;
        if (input.timeoutMs !== undefined) {
          timeoutHandle = setTimeout(() => child.kill("SIGTERM"), input.timeoutMs);
          timeoutHandle.unref();
        }
        child.stdout.on("data", (b: Buffer) => stdout.push(b));
        child.stderr.on("data", (b: Buffer) => stderr.push(b));
        child.on("close", (code) => {
          if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
          if (code !== 0) {
            reject(new Error(Buffer.concat(stderr).toString("utf8") || `ssh exited ${code}`));
            return;
          }
          resolve({
            exitCode: code,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          });
        });
        child.on("error", reject);
      });
    },
    async scp(input) {
      if (input.direction === "from") {
        const dir = await mkdtemp(path.join(tmpdir(), "aaspai-exedev-"));
        const localPath = path.join(dir, path.basename(input.remotePath));
        const scpArgs = [
          "-P",
          "22",
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=accept-new",
        ];
        if (input.identity) scpArgs.push("-i", input.identity, "-o", "IdentitiesOnly=yes");
        scpArgs.push(`${input.sshDest}:${input.remotePath}`, localPath);
        try {
          await new Promise<void>((resolve, reject) => {
            const child = spawn("scp", scpArgs, { stdio: "ignore", windowsHide: true });
            child.on("close", (code) =>
              code === 0 ? resolve() : reject(new Error(`scp failed (${code})`)),
            );
            child.on("error", reject);
          });
          const { readFile } = await import("node:fs/promises");
          return new Uint8Array(await readFile(localPath));
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
      // Uploads are handled via shell printf in the filesystem adapter; this
      // surface intentionally does not push content through scp.
      return undefined;
    },
  };
}

export function exeDevRuntimeError(message: string): Error {
  return runtimeError("PROVISION_FAILED", message);
}
