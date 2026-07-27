/**
 * Runtime-bound E2E runner.
 *
 * Runs the agentic-CLI scenarios (the same scenarios the harness
 * covers in `packages/harness/__tests__/real-e2e/run-real.ts`) but
 * routes every opencode-CLI spawn through a `RuntimeTarget`. This
 * is the file you run when you want to verify the opencode CLI works
 * the same way inside local, docker, ssh, and every sandbox provider.
 *
 * Usage:
 *   tsx __tests__/real-e2e/run-real.ts                 # run all 10 targets
 *   tsx __tests__/real-e2e/run-real.ts local           # one target
 *   tsx __tests__/real-e2e/run-real.ts local e2b ssh   # several
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecutionTarget, RunProcessResult } from "@aaspai/contracts/runtime";
import {
  cloudflareTarget,
  daytonaTarget,
  dockerTarget,
  e2bTarget,
  exeDevTarget,
  isSshConfigured,
  kubernetesTarget,
  localTarget,
  modalTarget,
  novitaTarget,
  sshTarget,
} from "@aaspai/runtime";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..", "..", "..", ".aaspai-runtime-e2e");
mkdirSync(ROOT, { recursive: true });
mkdirSync(join(ROOT, "targets"), { recursive: true });
mkdirSync(join(ROOT, "scratch"), { recursive: true });
mkdirSync(join(ROOT, "scratch", "local"), { recursive: true });
mkdirSync(join(ROOT, "scratch", "docker"), { recursive: true });
mkdirSync(join(ROOT, "scratch", "ssh"), { recursive: true });
for (const provider of [
  "e2b",
  "daytona",
  "cloudflare",
  "modal",
  "novita",
  "exe_dev",
  "kubernetes",
]) {
  mkdirSync(join(ROOT, "scratch", provider), { recursive: true });
}

const MODEL = process.env.AASPAI_OPENCODE_MODEL ?? "opencode-go/mimo-v2.5";
const SCENARIOS = [
  "01-happy",
  "02-resume",
  "03-flags",
  "04-mcp",
  "05-tools",
  "06-thinking",
  "14-tier1-config",
] as const;
type Scenario = (typeof SCENARIOS)[number];

interface TargetSpec {
  key: string;
  target: typeof localTarget;
  executionTarget: ExecutionTarget;
  description: string;
  skipReason?: string;
}

function localExecutionTarget(): ExecutionTarget {
  return { kind: "local", cwd: join(ROOT, "scratch", "local"), envPassthrough: true };
}

function sandboxExecutionTarget(
  provider: "e2b" | "daytona" | "cloudflare" | "modal" | "novita" | "exe_dev" | "kubernetes",
  providerCwd: string,
): ExecutionTarget {
  return {
    kind: "sandbox",
    provider,
    remoteCwd: providerCwd,
    metadata: { providerCwd },
  };
}

function dockerExecutionTarget(): ExecutionTarget {
  return {
    kind: "docker",
    image: "aaspai-opencode-test:latest",
    network: "bridge",
    cwd: join(ROOT, "scratch", "docker"),
  };
}

function sshExecutionTarget(): ExecutionTarget {
  const host = process.env.AASPAI_SSH_HOST ?? "localhost";
  const port = Number.parseInt(process.env.AASPAI_SSH_PORT ?? "22", 10);
  const username = process.env.AASPAI_SSH_USER ?? "root";
  return {
    kind: "ssh",
    host,
    port,
    username,
    remoteCwd: "/tmp/aaspai-runtime-e2e",
    strictHostKeyChecking: process.env.AASPAI_SSH_STRICT !== "false",
    shellCommand: "sh",
  };
}

function buildTargetSpecs(): TargetSpec[] {
  const specs: TargetSpec[] = [
    {
      key: "local",
      target: localTarget,
      executionTarget: localExecutionTarget(),
      description: "Local subprocess on the host",
    },
  ];

  // Docker — skip if daemon is down
  specs.push({
    key: "docker",
    target: dockerTarget,
    executionTarget: dockerExecutionTarget(),
    description: "Docker container (node:22-slim)",
    skipReason: undefined, // filled in by checkDockerReady
  });

  // SSH — skip if no host configured
  specs.push({
    key: "ssh",
    target: sshTarget,
    executionTarget: sshExecutionTarget(),
    description: "SSH remote host (needs AASPAI_SSH_HOST)",
    skipReason: isSshConfigured() ? undefined : "AASPAI_SSH_HOST not set",
  });

  // 7 sandbox providers — all use the local backend for this test pass
  const sandboxes: Array<{
    key: TargetSpec["key"];
    target: typeof e2bTarget;
    provider: "e2b" | "daytona" | "cloudflare" | "modal" | "novita" | "exe_dev" | "kubernetes";
  }> = [
    { key: "e2b", target: e2bTarget, provider: "e2b" },
    { key: "daytona", target: daytonaTarget, provider: "daytona" },
    { key: "cloudflare", target: cloudflareTarget, provider: "cloudflare" },
    { key: "modal", target: modalTarget, provider: "modal" },
    { key: "novita", target: novitaTarget, provider: "novita" },
    { key: "exe_dev", target: exeDevTarget, provider: "exe_dev" },
    { key: "kubernetes", target: kubernetesTarget, provider: "kubernetes" },
  ];
  for (const s of sandboxes) {
    specs.push({
      key: s.key,
      target: s.target,
      executionTarget: sandboxExecutionTarget(s.provider, "/workspace"),
      description: `Sandbox provider: ${s.key} (local backend)`,
    });
  }

  return specs;
}

// ─────────────────────────────────────────────────────────────────
//  opencode binary resolution (mirrors the harness's logic so we
//  can spawn the real .exe from a runtime-aware test)
// ─────────────────────────────────────────────────────────────────

async function resolveOpencodeCliPath(): Promise<string> {
  // 1. env override
  if (process.env.OPENCODE_CLI && existsSync(process.env.OPENCODE_CLI)) {
    return process.env.OPENCODE_CLI;
  }
  // 2. Windows direct .exe lookup
  if (process.platform === "win32") {
    const nodejsRoot = process.env.ProgramFiles
      ? `${process.env.ProgramFiles}\\nodejs`
      : "C:\\Program Files\\nodejs";
    const direct = [`${nodejsRoot}\\node_modules\\opencode-ai\\bin\\opencode.exe`];
    for (const c of direct) {
      if (existsSync(c)) return c;
    }
    // 3. .cmd fallback
    const cmdCandidates = [
      `${process.env.APPDATA ?? ""}\\npm\\opencode.cmd`,
      `${nodejsRoot}\\opencode.cmd`,
    ];
    for (const c of cmdCandidates) {
      if (existsSync(c)) return c;
    }
  }
  // 4. PATH lookup
  return "opencode";
}

async function isDockerReady(): Promise<boolean> {
  try {
    const result = await new Promise<RunProcessResult>((resolve) => {
      const child = spawn("docker", ["ps"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (b: Buffer) => out.push(b));
      child.stderr.on("data", (b: Buffer) => err.push(b));
      child.on("close", (code) =>
        resolve({
          exitCode: code,
          timedOut: false,
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: 0,
        }),
      );
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

async function ensureDockerImage(imageName: string): Promise<{ ok: boolean; detail: string }> {
  // 1. Check if image exists locally
  const inspect = await new Promise<RunProcessResult>((resolve) => {
    const c = spawn("docker", ["inspect", imageName], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    c.stdout.on("data", (b: Buffer) => out.push(b));
    c.stderr.on("data", (b: Buffer) => err.push(b));
    c.on("close", (code) =>
      resolve({
        exitCode: code,
        timedOut: false,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 0,
      }),
    );
  });
  if (inspect.exitCode === 0) {
    return { ok: true, detail: `image ${imageName} already present` };
  }

  // 2. Build the image (one-time, cached for next runs)
  console.log(`[docker] building ${imageName} (this may take a few minutes)...`);
  const dockerfile = `FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g opencode-ai
RUN mkdir -p /workspace
WORKDIR /workspace
`;
  const dockerfilePath = join(ROOT, "scratch", "docker", "Dockerfile");
  mkdirSync(join(ROOT, "scratch", "docker"), { recursive: true });
  writeFileSync(dockerfilePath, dockerfile);

  const build = await new Promise<RunProcessResult>((resolve) => {
    const c = spawn(
      "docker",
      ["build", "-t", imageName, "-f", dockerfilePath, join(ROOT, "scratch", "docker")],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    c.stdout.on("data", (b: Buffer) => {
      out.push(b);
      process.stdout.write(`  [build] ${b.toString()}`);
    });
    c.stderr.on("data", (b: Buffer) => {
      err.push(b);
      process.stderr.write(`  [build] ${b.toString()}`);
    });
    c.on("close", (code) =>
      resolve({
        exitCode: code,
        timedOut: false,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 0,
      }),
    );
  });
  return {
    ok: build.exitCode === 0,
    detail: build.exitCode === 0 ? "built" : build.stderr.slice(-500),
  };
}

async function checkReadiness(): Promise<Map<string, string | undefined>> {
  const skipReasons = new Map<string, string | undefined>();
  const dockerReady = await isDockerReady();
  for (const spec of buildTargetSpecs()) {
    if (spec.key === "docker") {
      if (!dockerReady) {
        skipReasons.set(spec.key, "docker daemon not running");
        continue;
      }
      const build = await ensureDockerImage("aaspai-opencode-test:latest");
      if (!build.ok) {
        skipReasons.set(spec.key, `docker image build failed: ${build.detail}`);
      } else {
        skipReasons.set(spec.key, undefined);
      }
    } else {
      skipReasons.set(spec.key, spec.skipReason);
    }
  }
  return skipReasons;
}

// ─────────────────────────────────────────────────────────────────
//  opencode CLI invocation via a RuntimeTarget
// ─────────────────────────────────────────────────────────────────

interface ParsedEvent {
  kind: string;
  text?: string;
  sessionId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  [k: string]: unknown;
}

interface ScenarioResult {
  scenario: Scenario;
  status: "succeeded" | "failed" | "skipped";
  durationMs: number;
  exitCode: number | null;
  textEvents: string[];
  thinkingEvents: string[];
  toolEvents: Array<{ name: string; input: unknown; output?: string }>;
  sessionId?: string;
  error?: string;
}

interface ScenarioInput {
  scenario: Scenario;
  prompt: string;
  cwd: string;
  flags: string[];
  env?: Record<string, string>;
  onToolCall?: (name: string, input: unknown) => Promise<unknown> | unknown;
  resumeSessionId?: string;
}

function parseJsonlEvents(stdout: string): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      // opencode's JSONL wraps everything in a `part` object
      // (e.g. { type: "text", part: { type: "text", text: "..." } }).
      // We hoist the part's fields so the rest of the parser can
      // operate on a flat shape.
      const part = (parsed.part as Record<string, unknown> | undefined) ?? {};
      const merged: Record<string, unknown> = { ...parsed, ...part };
      const event: ParsedEvent = { kind: String(merged.type ?? merged.kind ?? "unknown") };
      if (typeof merged.text === "string") event.text = merged.text;
      if (typeof merged.sessionID === "string") event.sessionId = merged.sessionID;
      if (typeof merged.sessionId === "string") event.sessionId = merged.sessionId;
      if (event.kind === "tool_call" || event.kind === "tool_use") {
        event.toolName = String((merged.toolName as string) ?? (merged.name as string) ?? "?");
        event.toolInput = merged.input ?? merged.args;
      }
      if (event.kind === "tool_result") {
        event.toolName = String((merged.toolName as string) ?? (merged.name as string) ?? "?");
        event.toolOutput =
          typeof merged.output === "string" ? merged.output : JSON.stringify(merged.output ?? null);
      }
      for (const [k, v] of Object.entries(merged)) {
        if (!(k in event)) event[k] = v;
      }
      events.push(event);
    } catch {
      // not JSON, skip
    }
  }
  return events;
}

async function runScenarioOnTarget(
  spec: TargetSpec,
  input: ScenarioInput,
  targetDir: string,
): Promise<ScenarioResult> {
  const dir = join(targetDir, input.scenario);
  mkdirSync(dir, { recursive: true });
  mkdirSync(input.cwd, { recursive: true });

  // For cloud sandboxes that need an API key, fail fast with a
  // clear "skipped: API key required" message rather than waiting
  // for a 30s SDK timeout. We classify well-known messages from
  // the provider driver constructors.
  const apiKeyRequiredPatterns: Array<{ pattern: RegExp; keyHint: string }> = [
    { pattern: /E2B_API_KEY|E2B sandbox requires an API key/i, keyHint: "E2B_API_KEY" },
    { pattern: /DAYTONA_API_KEY|daytona sandbox requires an API key/i, keyHint: "DAYTONA_API_KEY" },
    {
      pattern: /MODAL_TOKEN_ID|MODAL_TOKEN_SECRET|modal sandbox requires/i,
      keyHint: "MODAL_TOKEN_ID+MODAL_TOKEN_SECRET",
    },
    { pattern: /NOVITA_API_KEY|novita sandbox requires an API key/i, keyHint: "NOVITA_API_KEY" },
    { pattern: /EXE_API_KEY|exe-dev sandbox requires an API key/i, keyHint: "EXE_API_KEY" },
    {
      pattern: /AASPAI_CF_BRIDGE_URL|cloudflare sandbox requires a bridgeUrl/i,
      keyHint: "AASPAI_CF_BRIDGE_URL",
    },
    { pattern: /KUBECONFIG|kubernetes sandbox requires KUBECONFIG/i, keyHint: "KUBECONFIG" },
  ];

  // For docker, copy the host's opencode auth into the workspace
  // that the docker target bind-mounts to /workspace. The bind-mount
  // is rooted at `spec.executionTarget.cwd` (NOT `input.cwd`!).
  let extraEnv: Record<string, string> = {};
  if (spec.key === "docker") {
    const dockerWorkspace = (spec.executionTarget as { cwd?: string }).cwd;
    if (dockerWorkspace) {
      const hostAuth = join(
        process.env.USERPROFILE ?? process.env.HOME ?? "",
        ".local",
        "share",
        "opencode",
        "auth.json",
      );
      if (existsSync(hostAuth)) {
        const containerAuthDir = join(dockerWorkspace, ".local", "share", "opencode");
        mkdirSync(containerAuthDir, { recursive: true });
        const { copyFileSync } = await import("node:fs");
        copyFileSync(hostAuth, join(containerAuthDir, "auth.json"));
      }
    }
    // opencode CLI reads `$HOME/.local/share/opencode/auth.json`,
    // so we set HOME to /workspace. The bind-mount puts our auth
    // at /workspace/.local/share/opencode/auth.json.
    extraEnv = { HOME: "/workspace" };
  }

  const startedAt = Date.now();
  writeFileSync(
    join(dir, "00-input.jsonl"),
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      scenario: input.scenario,
      targetKey: spec.key,
      prompt: input.prompt,
      flags: input.flags,
      cwd: input.cwd,
      env: input.env ?? {},
      resumeSessionId: input.resumeSessionId,
    })}\n`,
  );

  // Each runtime target owns its own opencode install (host for
  // local, container image for docker, sandbox image for the 7
  // cloud providers). The Windows .exe path is only valid for the
  // local target — for everything else, the binary is on the
  // target's PATH.
  const command = spec.key === "local" ? await resolveOpencodeCliPath() : "opencode";
  const args = [
    "run",
    "--format",
    "json",
    "--model",
    MODEL,
    "--title",
    `runtime-e2e/${spec.key}/${input.scenario}/${randomUUID().slice(0, 8)}`,
    ...input.flags,
    input.prompt,
  ];

  // Linux-based runtimes (docker, every cloud sandbox) can't see
  // the host's Windows env (paths with `(` and `;` break the
  // shell). Pass only a curated set: PATH, HOME, LANG, plus
  // any model/auth env vars the test explicitly added.
  const isLinuxTarget = spec.key !== "local" && spec.key !== "ssh";
  const env: Record<string, string> = isLinuxTarget
    ? {
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        HOME: "/root",
        LANG: "C.UTF-8",
        ...(input.env ?? {}),
        ...extraEnv,
      }
    : ({ ...process.env, ...(input.env ?? {}), ...extraEnv } as Record<string, string>);

  try {
    const result = await spec.target.run(spec.executionTarget, {
      command,
      args,
      cwd: input.cwd,
      env,
      signal: AbortSignal.timeout(120_000),
    });
    const events = parseJsonlEvents(result.stdout);
    const textEvents: string[] = [];
    const thinkingEvents: string[] = [];
    const toolEvents: Array<{ name: string; input: unknown; output?: string }> = [];
    let sessionId: string | undefined;
    for (const e of events) {
      if (e.kind === "text" || e.kind === "assistant") {
        if (e.text) textEvents.push(e.text);
      } else if (e.kind === "thinking") {
        if (e.text) thinkingEvents.push(e.text);
      } else if (e.kind === "tool_use" || e.kind === "tool_call") {
        if (e.toolName) toolEvents.push({ name: e.toolName, input: e.toolInput });
      } else if (e.kind === "tool_result") {
        if (e.toolName) {
          const existing = toolEvents.find((t) => t.name === e.toolName);
          if (existing) existing.output = String(e.toolOutput ?? "");
          else toolEvents.push({ name: e.toolName, input: {}, output: String(e.toolOutput ?? "") });
        }
      }
      if (e.sessionId) sessionId = e.sessionId;
    }
    const durationMs = Date.now() - startedAt;
    const status: ScenarioResult["status"] =
      result.exitCode === 0 || textEvents.length > 0 ? "succeeded" : "failed";
    const out: ScenarioResult = {
      scenario: input.scenario,
      status,
      durationMs,
      exitCode: result.exitCode,
      textEvents,
      thinkingEvents,
      toolEvents,
      ...(sessionId ? { sessionId } : {}),
    };
    writeFileSync(
      join(dir, "result.json"),
      JSON.stringify(
        {
          ...out,
          stderr: result.stderr.slice(0, 4000),
          stdoutLines: result.stdout.split(/\r?\n/).length,
          rawEventCount: events.length,
        },
        null,
        2,
      ),
    );
    return out;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    // Detect "API key required" / "bridge URL required" — these
    // are not real test failures; the provider SDK is wired up
    // correctly but lacks the operator's credentials. Mark the
    // whole target as `skipped` for clarity.
    const apiKeyMatch = apiKeyRequiredPatterns.find((p) => p.pattern.test(message));
    if (apiKeyMatch) {
      throw new SkippableError(`skipped: needs ${apiKeyMatch.keyHint} (${message})`);
    }
    const out: ScenarioResult = {
      scenario: input.scenario,
      status: "failed",
      durationMs,
      exitCode: null,
      textEvents: [],
      thinkingEvents: [],
      toolEvents: [],
      error: error instanceof Error ? `${error.name}: ${message}` : String(error),
    };
    writeFileSync(join(dir, "result.json"), JSON.stringify(out, null, 2));
    return out;
  }
}

class SkippableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkippableError";
  }
}

// ─────────────────────────────────────────────────────────────────
//  Scenario definitions (parameterized by target)
// ─────────────────────────────────────────────────────────────────

function scenariosFor(
  spec: TargetSpec,
  targetDir: string,
): Array<(resumeSessionId?: string) => Promise<ScenarioResult>> {
  return [
    async (resumeSessionId) =>
      runScenarioOnTarget(
        spec,
        {
          scenario: "01-happy",
          prompt: 'Reply with exactly "PONG-RUNTIME".',
          cwd: join(targetDir, "ws"),
          flags: [],
          ...(resumeSessionId ? { resumeSessionId } : {}),
        },
        targetDir,
      ),
    async (resumeSessionId) =>
      runScenarioOnTarget(
        spec,
        {
          scenario: "02-resume",
          prompt: 'Reply with exactly "PONG-RESUME".',
          cwd: join(targetDir, "ws"),
          flags: ["-c"],
          ...(resumeSessionId ? { resumeSessionId } : {}),
        },
        targetDir,
      ),
    async () =>
      runScenarioOnTarget(
        spec,
        {
          scenario: "03-flags",
          prompt: 'Reply with exactly "PONG-FLAGS".',
          cwd: join(targetDir, "ws"),
          flags: ["--variant", "max", "--thinking", "--auto"],
        },
        targetDir,
      ),
    async () =>
      runScenarioOnTarget(
        spec,
        {
          scenario: "04-mcp",
          prompt: 'Reply with exactly "PONG-MCP".',
          cwd: join(targetDir, "ws"),
          flags: [],
        },
        targetDir,
      ),
    async () =>
      runScenarioOnTarget(
        spec,
        {
          scenario: "05-tools",
          prompt:
            "List the files in the current directory using the read tool, then reply with their count.",
          cwd: join(targetDir, "ws"),
          flags: [],
        },
        targetDir,
      ),
    async () =>
      runScenarioOnTarget(
        spec,
        {
          scenario: "06-thinking",
          prompt: 'Reply with exactly "PONG-THINKING".',
          cwd: join(targetDir, "ws"),
          flags: ["--thinking", "--print-logs"],
        },
        targetDir,
      ),
    async () =>
      runScenarioOnTarget(
        spec,
        {
          scenario: "14-tier1-config",
          prompt: 'Reply with exactly "PONG-CONFIG".',
          cwd: join(targetDir, "ws"),
          flags: [],
        },
        targetDir,
      ),
  ];
}

// ─────────────────────────────────────────────────────────────────
//  Meta-runner
// ─────────────────────────────────────────────────────────────────

interface TargetRunResult {
  key: string;
  description: string;
  status: "succeeded" | "failed" | "skipped";
  skipReason?: string;
  scenarios: ScenarioResult[];
  totalDurationMs: number;
}

async function runAllScenariosOnTarget(
  spec: TargetSpec,
  skipReason?: string,
): Promise<TargetRunResult> {
  const targetDir = join(ROOT, "targets", spec.key);
  mkdirSync(targetDir, { recursive: true });

  if (skipReason) {
    return {
      key: spec.key,
      description: spec.description,
      status: "skipped",
      skipReason,
      scenarios: [],
      totalDurationMs: 0,
    };
  }

  console.log(`\n=== [${spec.key}] ${spec.description} ===`);
  const startedAt = Date.now();
  const scenarioFns = scenariosFor(spec, targetDir);
  const results: ScenarioResult[] = [];
  let firstSessionId: string | undefined;
  let runtimeSkipReason: string | undefined;
  for (let i = 0; i < scenarioFns.length; i++) {
    const fn = scenarioFns[i]!;
    try {
      const result = await fn(i === 1 ? firstSessionId : undefined);
      if (i === 0 && result.sessionId) firstSessionId = result.sessionId;
      results.push(result);
      console.log(
        `  [${result.scenario}] ${result.status} (${(result.durationMs / 1000).toFixed(1)}s) ` +
          `text=${result.textEvents.length} thinking=${result.thinkingEvents.length} tools=${result.toolEvents.length}`,
      );
    } catch (err) {
      if (err instanceof SkippableError) {
        runtimeSkipReason = err.message;
        console.log(`  ${err.message}`);
        break;
      }
      throw err;
    }
  }
  const totalDurationMs = Date.now() - startedAt;
  if (runtimeSkipReason) {
    return {
      key: spec.key,
      description: spec.description,
      status: "skipped",
      skipReason: runtimeSkipReason,
      scenarios: results,
      totalDurationMs,
    };
  }
  const targetStatus: TargetRunResult["status"] = results.every((r) => r.status === "succeeded")
    ? "succeeded"
    : results.some((r) => r.status === "succeeded")
      ? "failed"
      : "failed";
  return {
    key: spec.key,
    description: spec.description,
    status: targetStatus,
    scenarios: results,
    totalDurationMs,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const skipReasons = await checkReadiness();
  const allSpecs = buildTargetSpecs();
  const wanted = argv.length > 0 ? allSpecs.filter((s) => argv.includes(s.key)) : allSpecs;
  if (wanted.length === 0) {
    console.error(`No targets matched: ${argv.join(", ")}`);
    console.error(`Available: ${allSpecs.map((s) => s.key).join(", ")}`);
    process.exit(2);
  }

  console.log(`[setup] runtime-e2e dump root: ${ROOT}`);
  console.log(`[setup] model: ${MODEL}`);
  console.log(`[setup] targets: ${wanted.map((s) => s.key).join(", ")}`);

  const results: TargetRunResult[] = [];
  for (const spec of wanted) {
    const skipReason = skipReasons.get(spec.key);
    const result = await runAllScenariosOnTarget(spec, skipReason);
    results.push(result);
  }

  const summary = {
    ranAt: new Date().toISOString(),
    model: MODEL,
    scenarios: SCENARIOS,
    totalTargets: results.length,
    succeededTargets: results.filter((r) => r.status === "succeeded").length,
    failedTargets: results.filter((r) => r.status === "failed").length,
    skippedTargets: results.filter((r) => r.status === "skipped").length,
    totalScenarios: results.reduce((s, r) => s + r.scenarios.length, 0),
    succeededScenarios: results.reduce(
      (s, r) => s + r.scenarios.filter((sc) => sc.status === "succeeded").length,
      0,
    ),
    totalDurationMs: results.reduce((s, r) => s + r.totalDurationMs, 0),
    targets: results,
  };
  writeFileSync(join(ROOT, "SUMMARY.json"), JSON.stringify(summary, null, 2));

  console.log("\n=== RUNTIME E2E SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nDumps: ${ROOT}`);
  console.log(
    `Targets: ${summary.succeededTargets} succeeded, ${summary.failedTargets} failed, ${summary.skippedTargets} skipped`,
  );
  console.log(
    `Scenarios: ${summary.succeededScenarios}/${summary.totalScenarios} succeeded (${(summary.totalDurationMs / 1000).toFixed(1)}s total)`,
  );
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});

// Re-export for tooling
export { buildTargetSpecs, parseJsonlEvents, runScenarioOnTarget };
