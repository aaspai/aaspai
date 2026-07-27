import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { RunProcessOptions, RunProcessResult } from "@aaspai/contracts/runtime";
import type { SandboxClient, SandboxLease } from "../sandbox-client.js";
import {
  SdkSandboxDriver,
  shellQuote,
  toRunResult,
} from "../sdk-sandbox-driver.js";

/**
 * Default setup script. Installs Node 20 (and git) so the agent CLI works
 * on a fresh exe.dev VM. Matches the paperclip default.
 */
const DEFAULT_SETUP_SCRIPT = `set -e
. /etc/profile
apt-get update -y
apt-get install -y curl ca-certificates git
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
`;

class ExeDevApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = "ExeDevApiError";
  }
}

function resolveApiKey(input: { apiKey?: string | null }): string {
  const apiKey = input.apiKey?.trim() || process.env.EXE_API_KEY?.trim() || "";
  if (!apiKey) {
    throw new Error("exe-dev sandbox requires an API key in config or EXE_API_KEY env var");
  }
  return apiKey;
}

function resolveApiUrl(input: { apiUrl?: string | null }): string {
  return input.apiUrl?.trim() || process.env.EXE_API_URL?.trim() || "https://exe.dev/exec";
}

/**
 * VM record parsed from exe.dev's JSON CLI output.
 * The actual API is a text/plain endpoint that returns either a JSON
 * object (or array) of VM records, or a `{"vm": {...}}` / `{"data": {...}}`
 * envelope.
 */
interface ExeDevVm {
  name: string;
  sshDest: string;
  httpsUrl?: string;
  status?: string;
  region?: string;
}

function parseVmRecord(value: unknown, depth = 0): ExeDevVm | null {
  if (depth > 3) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  // Recurse into known envelopes.
  const nested =
    parseVmRecord(record.vm, depth + 1) ??
    parseVmRecord(record.data, depth + 1);
  if (nested) return nested;

  const name =
    typeof record.vm_name === "string" ? record.vm_name :
    typeof record.name === "string" ? record.name :
    typeof record.vmName === "string" ? record.vmName :
    null;
  const sshDest =
    typeof record.ssh_dest === "string" ? record.ssh_dest :
    typeof record.sshDest === "string" ? record.sshDest :
    name ? `${name}.exe.xyz` : null;
  if (!name || !sshDest) return null;
  return {
    name,
    sshDest,
    httpsUrl: typeof record.https_url === "string" ? record.https_url :
              typeof record.httpsUrl === "string" ? record.httpsUrl : undefined,
    status: typeof record.status === "string" ? record.status : undefined,
    region: typeof record.region === "string" ? record.region : undefined,
  };
}

function buildCreateCommand(opts: {
  name: string;
  image: string;
  command: string;
  setupScript?: string;
}): string {
  const parts = [
    "new",
    "--json",
    "--no-email",
    `--name=${shellQuote(opts.name)}`,
    `--image=${shellQuote(opts.image)}`,
    `--command=${shellQuote(opts.command)}`,
  ];
  if (opts.setupScript) {
    parts.push(`--setup-script=${shellQuote(opts.setupScript)}`);
  }
  return parts.join(" ");
}

/**
 * Send a single CLI command to the exe.dev `text/plain` endpoint.
 * Returns the parsed JSON response (or null if the body was empty),
 * matching paperclip's `runLifecycleCommand`.
 */
async function runLifecycleCommand(
  apiUrl: string,
  apiKey: string,
  command: string,
  timeoutMs: number,
  logCommand?: string,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 60_000));
  timer.unref();
  let response: Response;
  try {
    response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
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
    throw new ExeDevApiError(
      `exe.dev API command failed (${response.status}) for: ${logCommand ?? command}`,
      response.status,
      body,
    );
  }
  const trimmed = body.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return body;
  }
}

async function lookupVm(apiUrl: string, apiKey: string, vmName: string, timeoutMs: number): Promise<ExeDevVm | null> {
  const response = await runLifecycleCommand(apiUrl, apiKey, `ls --json ${shellQuote(vmName)}`, timeoutMs);
  const list: unknown[] = Array.isArray((response as { vms?: unknown[] } | null)?.vms)
    ? (response as { vms: unknown[] }).vms
    : Array.isArray(response)
      ? response
      : response
        ? [response]
        : [];
  for (const candidate of list) {
    const parsed = parseVmRecord(candidate);
    if (parsed?.name === vmName || parsed?.sshDest === vmName) {
      return parsed;
    }
  }
  return null;
}

/**
 * Stage the SSH private key to a 0o600 temp file. Returns the
 * temp file path (caller must `unlink` it). Mirrors paperclip's
 * `prepareSshIdentity`.
 */
async function prepareSshIdentity(rawKey: string): Promise<string> {
  const { mkdir, writeFile: wf, chmod } = await import("node:fs/promises");
  const dir = await mkdtemp(path.join(tmpdir(), "aaspai-exedev-key-"));
  const keyPath = join(dir, "id_ed25519");
  const normalized = rawKey.endsWith("\n") ? rawKey : `${rawKey}\n`;
  await wf(keyPath, normalized, { mode: 0o600 });
  await chmod(keyPath, 0o600);
  return keyPath;
}

/**
 * Best-effort, non-throwing cleanup for a staged key file.
 */
function cleanupSshIdentity(keyPath: string | undefined): void {
  if (!keyPath) return;
  void rm(keyPath, { force: true }).catch(() => undefined);
  void rm(path.dirname(keyPath), { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Real exe.dev-backed `SandboxDriver`. Uses the exe.dev REST API
 * (`https://exe.dev/exec` with `Content-Type: text/plain; charset=utf-8`
 * and a body like `new --json --no-email --name=...`) to create VMs,
 * then SSHes into them for command execution. The reference protocol
 * is `study/paperclip/packages/plugins/sandbox-providers/exe-dev/src/plugin.ts`.
 */
export class ExeDevSandboxDriver extends SdkSandboxDriver<ExeDevVm> {
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly image: string;
  private readonly command: string;
  private readonly sshPort: number;
  private readonly defaultTimeoutMs: number;

  constructor(options: {
    apiKey?: string | null;
    apiUrl?: string | null;
    image?: string;
    command?: string;
    sshPort?: number;
    timeoutMs?: number;
  } = {}) {
    super("exe_dev");
    this.apiKey = options.apiKey?.trim() ?? "";
    this.apiUrl = resolveApiUrl({ apiUrl: options.apiUrl });
    this.image = options.image ?? "ubuntu-24.04";
    this.command = options.command ?? "/bin/bash";
    this.sshPort = options.sshPort ?? 22;
    this.defaultTimeoutMs = options.timeoutMs ?? 60_000;
  }

  protected override async createSandbox(input: {
    remoteCwd: string;
    timeoutMs?: number;
  }): Promise<{ raw: ExeDevVm; remoteCwd: string; metadata: Record<string, unknown> }> {
    const apiKey = resolveApiKey({ apiKey: this.apiKey });
    const apiUrl = this.apiUrl;
    const timeoutMs = input.timeoutMs ?? this.defaultTimeoutMs;
    const vmName = `aaspai-${randomUUID().slice(0, 8)}`;
    const command = buildCreateCommand({
      name: vmName,
      image: this.image,
      command: this.command,
      setupScript: DEFAULT_SETUP_SCRIPT,
    });
    const response = await runLifecycleCommand(apiUrl, apiKey, command, timeoutMs);
    let vm = parseVmRecord(response);
    if (!vm) {
      // Fall back to an `ls` lookup if the create response wasn't parseable.
      vm = await lookupVm(apiUrl, apiKey, vmName, timeoutMs);
    }
    if (!vm) {
      throw new Error(`exe.dev did not return VM metadata for ${vmName}`);
    }
    return {
      raw: vm,
      remoteCwd: input.remoteCwd,
      metadata: {
        name: vm.name,
        sshDest: vm.sshDest,
        httpsUrl: vm.httpsUrl,
        region: vm.region,
        image: this.image,
      },
    };
  }

  protected override async reconnect(providerLeaseId: string): Promise<ExeDevVm | null> {
    // exe.dev VMs are persistent; the lookup-via-`ls --json` path is
    // the same one paperclip uses to verify the VM still exists.
    const apiKey = resolveApiKey({ apiKey: this.apiKey });
    return await lookupVm(this.apiUrl, apiKey, providerLeaseId, this.defaultTimeoutMs);
  }

  protected override async destroySandbox(raw: ExeDevVm): Promise<void> {
    const apiKey = resolveApiKey({ apiKey: this.apiKey });
    // The exe.dev API is text/plain CLI: `rm --json <name>`.
    await runLifecycleCommand(
      this.apiUrl,
      apiKey,
      `rm --json ${shellQuote(raw.name)}`,
      this.defaultTimeoutMs,
    ).catch(() => undefined);
  }

  protected override leaseId(raw: ExeDevVm): string {
    return raw.name;
  }

  protected override buildClient(raw: ExeDevVm, lease: SandboxLease): SandboxClient {
    const sshTarget = raw.sshDest;
    const sshPort = this.sshPort;
    const execCommand = async (options: RunProcessOptions): Promise<RunProcessResult> => {
      const startedAt = new Date();
      const cmd = [options.command, ...(options.args ?? [])].map(shellQuote).join(" ");
      const wrapped = `cd ${shellQuote(lease.remoteCwd)} && ${cmd}`;
      const sshIdentity = process.env.AASPAI_SSH_KEY
        ? await prepareSshIdentity(process.env.AASPAI_SSH_KEY)
        : undefined;
      try {
        return await runSshExec({
          sshTarget,
          port: sshPort,
          identityFile: sshIdentity,
          remoteCommand: wrapped,
          options,
          startedAt,
        });
      } finally {
        cleanupSshIdentity(sshIdentity);
      }
    };

    return {
      async makeDir(remotePath, options) {
        await runOverSsh({ sshTarget, port: sshPort, remoteCommand: `mkdir ${options?.recursive === false ? "" : "-p"} ${shellQuote(remotePath)}` });
      },
      async writeFile(remotePath, content) {
        const text = typeof content === "string" ? content : Buffer.from(content).toString("utf8");
        const dir = await mkdtemp(path.join(tmpdir(), "aaspai-exedev-"));
        const localPath = join(dir, path.basename(remotePath));
        const sshIdentity = process.env.AASPAI_SSH_KEY
          ? await prepareSshIdentity(process.env.AASPAI_SSH_KEY)
          : undefined;
        try {
          await writeFile(localPath, text);
          await runScp({ sshTarget, port: sshPort, identityFile: sshIdentity, localPath, remotePath });
        } finally {
          cleanupSshIdentity(sshIdentity);
          await rm(dir, { recursive: true, force: true });
        }
      },
      async readFile(remotePath) {
        const dir = await mkdtemp(path.join(tmpdir(), "aaspai-exedev-"));
        const localPath = join(dir, path.basename(remotePath));
        const sshIdentity = process.env.AASPAI_SSH_KEY
          ? await prepareSshIdentity(process.env.AASPAI_SSH_KEY)
          : undefined;
        try {
          await runScp({ sshTarget, port: sshPort, identityFile: sshIdentity, localPath, remotePath, direction: "from" });
          const { readFile } = await import("node:fs/promises");
          return await readFile(localPath);
        } finally {
          cleanupSshIdentity(sshIdentity);
          await rm(dir, { recursive: true, force: true });
        }
      },
      async listFiles(remotePath) {
        const out = await runOverSsh({
          sshTarget,
          port: sshPort,
          remoteCommand: `cd ${shellQuote(remotePath)} && find . -mindepth 1 -maxdepth 1 -printf '%f|%s|%y\\n'`,
        });
        return out
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
        await runOverSsh({
          sshTarget,
          port: sshPort,
          remoteCommand: `rm ${options?.recursive === false ? "-f" : "-rf"} ${shellQuote(remotePath)}`,
        });
      },
      run: execCommand,
    };
  }
}

interface SshExecOptions {
  sshTarget: string;
  port: number;
  identityFile: string | undefined;
  remoteCommand: string;
  options: RunProcessOptions;
  startedAt: Date;
}

async function runSshExec(args: SshExecOptions): Promise<RunProcessResult> {
  const sshArgs = buildSshArgs({
    port: args.port,
    identityFile: args.identityFile,
    target: args.sshTarget,
    extra: ["-T", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=15"],
  });
  sshArgs.push(args.remoteCommand);
  return await new Promise<RunProcessResult>((resolve) => {
    const child = spawn("ssh", sshArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timeoutHandle: NodeJS.Timeout | undefined;
    if (args.options.timeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => child.kill("SIGTERM"), args.options.timeoutMs);
      timeoutHandle.unref();
    }
    child.stdout?.on("data", (b: Buffer) => {
      stdoutChunks.push(b);
      if (args.options.onLog) {
        void Promise.resolve(args.options.onLog("stdout", b.toString("utf8"))).catch(() => undefined);
      }
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderrChunks.push(b);
      if (args.options.onLog) {
        void Promise.resolve(args.options.onLog("stderr", b.toString("utf8"))).catch(() => undefined);
      }
    });
    child.on("close", (code, signal) => {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      resolve(
        toRunResult({
          exitCode: code,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          signal: signal ?? undefined,
          startedAt: args.startedAt,
        }),
      );
    });
  });
}

async function runOverSsh(args: {
  sshTarget: string;
  port: number;
  remoteCommand: string;
  identityFile?: string;
}): Promise<string> {
  const sshArgs = buildSshArgs({
    port: args.port,
    identityFile: args.identityFile,
    target: args.sshTarget,
    extra: ["-T", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=15"],
  });
  sshArgs.push(args.remoteCommand);
  return await new Promise((resolve, reject) => {
    const child = spawn("ssh", sshArgs, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => stdout.push(b));
    child.stderr.on("data", (b: Buffer) => stderr.push(b));
    child.on("close", (code) => {
      const out = Buffer.concat(stdout).toString("utf8");
      if (code !== 0) {
        const errText = Buffer.concat(stderr).toString("utf8");
        reject(new Error(formatSshFailure(args.remoteCommand, code, errText)));
        return;
      }
      resolve(out);
    });
  });
}

async function runScp(args: {
  sshTarget: string;
  port: number;
  identityFile: string | undefined;
  localPath: string;
  remotePath: string;
  direction?: "to" | "from";
}): Promise<void> {
  const direction = args.direction ?? "to";
  const scpArgs: string[] = [
    "-P", String(args.port),
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
  ];
  if (args.identityFile) {
    scpArgs.push("-i", args.identityFile, "-o", "IdentitiesOnly=yes");
  }
  if (direction === "to") {
    scpArgs.push(args.localPath, `${args.sshTarget}:${args.remotePath}`);
  } else {
    scpArgs.push(`${args.sshTarget}:${args.remotePath}`, args.localPath);
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn("scp", scpArgs, { stdio: "ignore", windowsHide: true });
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`scp failed (${code})`));
      else resolve();
    });
  });
}

function buildSshArgs(opts: {
  port: number;
  identityFile: string | undefined;
  target: string;
  extra: string[];
}): string[] {
  const args: string[] = [
    "-p", String(opts.port),
    "-o", "BatchMode=yes",
    ...opts.extra,
  ];
  if (opts.identityFile) {
    args.push("-i", opts.identityFile, "-o", "IdentitiesOnly=yes");
  }
  args.push(opts.target);
  return args;
}

/**
 * Wraps an SSH failure stderr with onboarding / key-format hints
 * matching paperclip's `formatSshFailure`.
 */
function formatSshFailure(command: string, code: number | null, stderr: string): string {
  if (stderr.includes("Please complete registration by running: ssh exe.dev")) {
    return `exe.dev requires one-time SSH onboarding. Run \`ssh exe.dev\` from this host, follow the prompts, then re-run. Original: ${command}`;
  }
  if (stderr.includes("Please enter your email address")) {
    return `exe.dev is asking for an email address (onboarding incomplete). Run \`ssh exe.dev\` and complete the email/registration prompt, then re-run.`;
  }
  if (/Load key .* invalid format/i.test(stderr)) {
    return `SSH private key in AASPAI_SSH_KEY is not in OpenSSH format. Convert it with \`ssh-keygen -p -m PEM -f <key>\` or PuTTYgen → "Export OpenSSH key".`;
  }
  if (stderr.length > 0) {
    return `ssh command failed (${code}): ${stderr}`;
  }
  return `ssh command failed (${code})`;
}
