/**
 * Shared test helpers for the harness / sessions opencode-cli e2e suite.
 *
 * The whole point of the e2e suite is "100% control over the CLI": the
 * real `opencode` binary is unpredictable (network-bound, model-routed,
 * session-store-bound to a per-user SQLite), and we want to assert that
 * the aaspai opencode-cli driver correctly translates every shape of
 * event the CLI can produce, every failure mode, and the cross-process
 * + cross-session plumbing.
 *
 * To do that, the tests point the adapter at `fake-opencode.cjs` (via
 * the `command` config field) and that fixture drives its output from
 * markers in the prompt plus a small handful of env vars. Every helper
 * in this file exists to make that plumbing one-liner at the test site.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/** Path to the fake opencode CLI script. */
export const FAKE_OPENCODE_CJS = join(__dirname, "..", "fixtures", "fake-opencode.cjs");

/** Path to the Windows .cmd shim that wraps the fake CLI. */
export const FAKE_OPENCODE_CMD = join(__dirname, "..", "fixtures", "fake-opencode.cmd");

/** Path to the POSIX shell shim that wraps the fake CLI. */
export const FAKE_OPENCODE_SH = join(__dirname, "..", "fixtures", "fake-opencode.sh");

/**
 * The path the test should pass as the `command` config field.
 *
 * On both Windows and POSIX we point the adapter at the Node binary
 * itself (process.execPath) and put the script path in `commandArgs`.
 * This works around the Windows child_process restriction that
 * refuses to spawn .cmd / .bat files without `shell: true` (a security
 * hardening added in Node 16+). The real `opencode` adapter sidesteps
 * the same restriction by spawning the underlying `opencode.exe`
 * directly from `node_modules\opencode-ai\bin\`. Both code paths
 * converge on the same `spawn(executable, args)` shape, so this is
 * a faithful e2e of the adapter's argv-construction logic.
 */
export function fakeOpencodeCommand(): string {
  return process.execPath;
}

/** Per-test scratch directory. */
export function makeScratchDir(prefix = "aaspai-e2e-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Cleanup helper — never throws. */
export function rmRf(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true });
  } catch {
    /* */
  }
}

/**
 * Build a stable but unique cross-process lock path under tmpdir for
 * the duration of a single test. The aaspai opencode-cli driver uses
 * this path to serialize concurrent invocations across processes.
 */
export function makeLockPath(label = "e2e"): string {
  const nonce = randomBytes(4).toString("hex");
  return join(tmpdir(), `aaspai-${label}-${process.pid}-${nonce}.lock`);
}

/** Per-test SQLite database for the sessions package. */
export function makeSqlitePath(label = "e2e"): string {
  const nonce = randomBytes(4).toString("hex");
  return join(tmpdir(), `aaspai-${label}-${process.pid}-${nonce}.db`);
}

/**
 * Minimum-viable AdapterExecutionContext for driving `opencodeCli.execute`
 * in a unit-style e2e test. The sessions e2e uses its own builder
 * because it has to wire up a real AgentConfigSource + KnowledgeSource.
 */
export function buildAdapterContext(opts: {
  prompt: string;
  cwd: string;
  runId: string;
  organizationId?: string;
  agentId?: string;
  agentName?: string;
  adapterConfig?: Record<string, unknown>;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void> | void;
  onMeta?: (meta: Record<string, unknown>) => Promise<void> | void;
  onRuntimeProgress?: (update: unknown) => Promise<void> | void;
  signal?: AbortSignal;
}) {
  const organizationId = opts.organizationId ?? "org_test_e2e";
  const agentId = opts.agentId ?? "agent/test-e2e";
  const agentName = opts.agentName ?? "test-e2e";
  const config: Record<string, unknown> = {
    command: fakeOpencodeCommand(),
    commandArgs: [FAKE_OPENCODE_CJS],
    title: "e2e-session",
    ...(opts.adapterConfig ?? {}),
  };
  // Force the model — every test in this file is about a deterministic
  // fake CLI, so pinning the model removes one variable.
  if (!("model" in config)) config.model = "opencode-go/mimo-v2.5";
  return {
    protocolVersion: 1 as const,
    runId: opts.runId,
    organizationId,
    agent: {
      id: agentId,
      organizationId,
      name: agentName,
      adapterType: "opencode_cli" as const,
      adapterConfig: {},
    },
    runtime: {
      sessionId: undefined,
      sessionParams: undefined,
      sessionDisplayId: undefined,
      taskKey: undefined,
    },
    config: config as never,
    context: {
      cwd: opts.cwd,
      prompt: opts.prompt,
    },
    onLog:
      opts.onLog ??
      (async () => {
        /* */
      }),
    onMeta: opts.onMeta,
    onRuntimeProgress: opts.onRuntimeProgress,
    signal: opts.signal,
  };
}

/**
 * Build an in-memory AgentConfigSource that returns the agent the
 * sessions test wants. The sessions package accepts any object that
 * satisfies the `AgentConfigSource` interface — no class is required.
 */
export function buildInMemoryAgentSource(agents: ReadonlyArray<Record<string, unknown>>) {
  const byId = new Map(agents.map((a) => [String(a.id), a]));
  return {
    async get(id: string) {
      const a = byId.get(id);
      if (!a) throw new Error(`agent not found: ${id}`);
      return a as never;
    },
    async has(id: string) {
      return byId.has(id);
    },
    async list() {
      return [...byId.keys()];
    },
    watch() {
      return () => {
        /* */
      };
    },
    describe() {
      return { kind: "memory", label: "e2e in-memory agent source" };
    },
  };
}

/** In-memory KnowledgeSource that returns nothing unless told to. */
export function buildInMemoryKnowledgeSource() {
  return {
    async get(_id: string) {
      throw new Error("not found");
    },
    async has(_id: string) {
      return false;
    },
    async list() {
      return [] as readonly string[];
    },
    async search() {
      return [] as readonly never[];
    },
    watch() {
      return () => {
        /* */
      };
    },
    describe() {
      return { kind: "memory", label: "e2e in-memory knowledge source" };
    },
  };
}

/** Parse one JSONL line from a captured opencode stream into an event object. */
export function parseJsonlLines(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") out.push(parsed as Record<string, unknown>);
    } catch {
      /* not JSON — caller can decide what to do */
    }
  }
  return out;
}

/** Build the AASPAI_AGENT_ID-style env vars the adapter injects (read-only). */
export function readAgentEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("AASPAI_")) out[k] = String(v);
  }
  return out;
}

/**
 * Ensure the parent directory of a file path exists. SQLite needs
 * the dir to exist before opening the file.
 */
export function ensureParentDir(filePath: string): void {
  const dir = filePath.split(sep).slice(0, -1).join(sep);
  if (dir && !existsSync(dir)) {
    // fs.mkdirSync(dir, { recursive: true });
    // We use a manual recursive impl because we don't want to import
    // node:fs at module scope; tests pull only what they need.
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(dir, { recursive: true });
  }
}

/** Quick env-set helper that restores on cleanup. */
export function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k]!;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

/** A complete fake AgentConfig row for the sessions test. */
export function buildFakeAgent(overrides: {
  id: string;
  adapter?: string;
  model?: string;
  systemPrompt?: string;
  role?: string;
  title?: string;
  adapterConfig?: Record<string, unknown>;
}) {
  return {
    id: overrides.id,
    type: "Agent" as const,
    title: overrides.title ?? "e2e-test-agent",
    description: "e2e fixture agent",
    timestamp: new Date().toISOString(),
    adapter: overrides.adapter ?? "opencode_cli",
    model: overrides.model ?? "opencode-go/mimo-v2.5",
    role: overrides.role ?? "general",
    reportsTo: null,
    manages: [],
    peers: [],
    systemPrompt: overrides.systemPrompt ?? "",
    adapterConfig: overrides.adapterConfig ?? {},
    runtimeConfig: {},
    runtime: {},
    tools: {},
    skills: [],
    knowledge: { include: [], exclude: [] },
    budget: {},
    relations: {},
  };
}
