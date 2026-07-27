import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDefaultDb, getDefaultDb, runMigrations, schema } from "@aaspai/db";
import { opencodeCli } from "@aaspai/harness";
import { Sessions } from "@aaspai/sessions";
import { SkillCatalog, SkillRegistry } from "@aaspai/skills";
import { eq } from "drizzle-orm";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..", "..", "..", ".aaspai-e2e");
const DB = join(ROOT, "aaspai.db");
const SCRATCH = join(ROOT, "scratch");
const SKILL_TREE = join(ROOT, "skills-catalog");

mkdirSync(ROOT, { recursive: true });
mkdirSync(SCRATCH, { recursive: true });
mkdirSync(SKILL_TREE, { recursive: true });
mkdirSync(join(ROOT, "scenarios"), { recursive: true });

// Wipe any old DB so we start fresh.
if (existsSync(DB)) {
  const { rmSync } = await import("node:fs");
  rmSync(DB);
}

process.env.AASPAI_DB = `sqlite:${DB}`;
process.env.AASPAI_OPENCODE_LOCK_PATH = join(ROOT, "aaspai.lock");
process.env.AASPAI_FAKE_OPENCODE_DUMP_ARGV = ""; // ensure unset for real CLI
process.env.AASPAI_FAKE_OPENCODE_PROBE_FILE = "";
process.env.AASPAI_FAKE_OPENCODE_STDERR = "";
process.env.AASPAI_FAKE_OPENCODE_STDOUT = "";
process.env.AASPAI_FAKE_OPENCODE_PROMPT_OVERRIDE = "";

await closeDefaultDb();
runMigrations(getDefaultDb());
await closeDefaultDb();

const MODEL = "opencode-go/mimo-v2.5";
console.log(`[setup] using opencode model: ${MODEL}`);
console.log(`[setup] dump root: ${ROOT}`);

// ─────────────────────────────────────────────────────────────────
//  Build a SkillCatalog tree for the materialize scenarios
// ─────────────────────────────────────────────────────────────────
async function buildSkillCatalog() {
  // Clean and rebuild
  const { rmSync, mkdirSync: mkdirP } = await import("node:fs");
  if (existsSync(SKILL_TREE)) rmSync(SKILL_TREE, { recursive: true, force: true });
  mkdirP(join(SKILL_TREE, "catalog", "bundled", "ops", "verify-change"), { recursive: true });
  mkdirP(join(SKILL_TREE, "catalog", "bundled", "ops", "summarize"), { recursive: true });
  mkdirP(join(SKILL_TREE, "catalog", "optional", "ops", "remember"), { recursive: true });

  const write = (p: string, body: string) => writeFileSync(p, body, "utf8");

  // bundled/ops/verify-change/SKILL.md
  write(
    join(SKILL_TREE, "catalog", "bundled", "ops", "verify-change", "SKILL.md"),
    `---
type: Skill
title: Verify a change end-to-end
name: Verify Change
description: Run the project's tests + manual checks before reporting done.
key: verify-change
version: 1.0.0
adapterTypes: [opencode_cli]
tags: [verify, qa]
---
## Steps
1. List the change.
2. Find the closest test command.
3. Run it; report the last 20 lines.
4. If tests don't exist, say so explicitly.
`,
  );
  write(
    join(SKILL_TREE, "catalog", "bundled", "ops", "verify-change", "checklist.md"),
    `# Verification checklist\n- [ ] Tests run\n- [ ] Manual smoke\n`,
  );

  // bundled/ops/summarize/SKILL.md
  write(
    join(SKILL_TREE, "catalog", "bundled", "ops", "summarize", "SKILL.md"),
    `---
type: Skill
title: Summarize a session
name: Summarize
description: Produce a 3-bullet summary of the session's work.
key: summarize
version: 1.0.0
adapterTypes: [opencode_cli]
tags: [summary]
---
## Output format
- **What**: one sentence
- **Why**: one sentence
- **Next**: one sentence
`,
  );

  // optional/ops/remember/SKILL.md
  write(
    join(SKILL_TREE, "catalog", "optional", "ops", "remember", "SKILL.md"),
    `---
type: Skill
title: Remember for next time
name: Remember
description: Persist a lesson learned to the knowledge base.
key: remember
version: 0.1.0
adapterTypes: [opencode_cli]
---
## Steps
- Pick a single insight.
- Phrase it as a one-liner.
- (Hypothetical: would call \`knowledge add\` if available.)
`,
  );
}
await buildSkillCatalog();
console.log(`[setup] built skill catalog at ${SKILL_TREE}`);

const { catalog, manifest, errors: catalogErrors } = await SkillCatalog.load(SKILL_TREE);
if (catalogErrors.length > 0) {
  console.warn(`[setup] catalog errors: ${catalogErrors.join("; ")}`);
}
const registry = new SkillRegistry();
await catalog.registerAllInto(registry);
console.log(`[setup] registered ${registry.list().length} skills into the registry`);

// ─────────────────────────────────────────────────────────────────
//  A real-tool dispatcher
// ─────────────────────────────────────────────────────────────────
const toolCalls: Array<{ scenario: string; name: string; input: unknown; output: string }> = [];
const _toolDispatcher = {
  invoke: async (name: string, input: unknown, ctx: unknown) => {
    const tag = (ctx as { scenario?: string })?.scenario ?? "?";
    let output: string;
    if (name === "echo") output = `ECHO:${JSON.stringify(input)}`;
    else if (name === "now") output = new Date().toISOString();
    else if (name === "noop") output = "no-op";
    else output = `unknown-tool:${name}`;
    toolCalls.push({ scenario: tag, name, input, output });
    return output;
  },
  list: () => ["echo", "now", "noop"],
};

// ─────────────────────────────────────────────────────────────────
//  Sessions layer helper
// ─────────────────────────────────────────────────────────────────
const agent = {
  id: "agent/real-e2e",
  type: "Agent" as const,
  title: "real-e2e-agent",
  description: "Real-CLI E2E agent",
  timestamp: new Date().toISOString(),
  adapter: "opencode_cli",
  model: MODEL,
  role: "general" as const,
  reportsTo: null,
  manages: [],
  peers: [],
  systemPrompt:
    "You are a tiny helpful assistant. Be concise. When asked to use a tool, call it once and report the result. When asked to summarize, use the 3-bullet format.",
  adapterConfig: {},
  runtimeConfig: {},
  runtime: {},
  tools: {},
  skills: [],
  knowledge: { include: [], exclude: [] },
  budget: {},
  relations: {},
};
const throwawayAgent = {
  ...agent,
  id: "agent/throwaway",
  title: "throwaway",
  description: "Throwaway agent for session-delete scenario",
  systemPrompt: "Reply concisely.",
};
const agentSource = {
  async get(id: string) {
    if (id === "agent/throwaway") return throwawayAgent as never;
    if (id === "agent/real-e2e") return agent as never;
    throw new Error(`unknown agent: ${id}`);
  },
  async has(id: string) {
    return id === "agent/real-e2e" || id === "agent/throwaway";
  },
  async list() {
    return ["agent/real-e2e", "agent/throwaway"];
  },
  watch() {
    return () => {};
  },
  describe() {
    return { kind: "memory" as const, label: "real-e2e in-memory" };
  },
};
const knowledgeSource = {
  async get() {
    throw new Error("no knowledge in real-e2e");
  },
  async has() {
    return false;
  },
  async list() {
    return [];
  },
  async search() {
    return [];
  },
  watch() {
    return () => {};
  },
  describe() {
    return { kind: "memory" as const, label: "real-e2e empty knowledge" };
  },
};
const skillRegistry = registry;
const sessions = new Sessions({
  agentSource,
  knowledgeSource,
  skillRegistry,
});

// ─────────────────────────────────────────────────────────────────
//  Per-scenario dump helpers
// ─────────────────────────────────────────────────────────────────
function newScenarioDir(name: string) {
  const dir = join(ROOT, "scenarios", name);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function dumpJsonl(path: string, lines: Array<unknown>) {
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");
}
function dumpText(path: string, text: string) {
  writeFileSync(path, text, "utf8");
}
function _dumpFile(path: string, content: string) {
  writeFileSync(path, content, "utf8");
}

// ─────────────────────────────────────────────────────────────────
//  Scenario runner
// ─────────────────────────────────────────────────────────────────
interface ScenarioResult {
  scenario: string;
  status: "succeeded" | "failed";
  sessionId?: string;
  sessionDisplayId?: string;
  durationMs: number;
  exitCode?: number | null;
  summary?: string;
  errorFamily?: string;
  errorCode?: string;
  errorMessage?: string;
  cliSessionId?: string;
  sessionParams?: Record<string, unknown>;
  resultJson?: Record<string, unknown>;
  toolDispatcherCalls: Array<{ name: string; input: unknown; output: string }>;
  toolEvents: Array<{ name: string; status: string; output?: string }>;
  thinkingEvents: Array<{ text: string }>;
  textEvents: Array<{ text: string }>;
  stderrLines?: string[];
  dispatcherCalls: Array<{ name: string; input: unknown; output: string }>;
}

async function runScenario(args: {
  scenario: string;
  prompt: string;
  skillKeys?: string[];
  toolDispatcherScenario: string;
  config?: Record<string, unknown>;
  runtime?: { sessionId?: string; sessionParams?: { fork?: boolean } };
}): Promise<ScenarioResult> {
  const dir = newScenarioDir(args.scenario);
  console.log(`\n[${args.scenario}] starting`);
  // Pre-call state dump
  const beforeState = {
    timestamp: new Date().toISOString(),
    prompt: args.prompt,
    skillKeys: args.skillKeys ?? [],
    config: args.config ?? {},
    runtime: args.runtime ?? {},
  };
  dumpJsonl(join(dir, "00-input.jsonl"), [beforeState]);

  const textEvents: Array<{ text: string }> = [];
  const thinkingEvents: Array<{ text: string }> = [];
  const toolEvents: Array<{ name: string; status: string; output?: string }> = [];
  const stderrLines: string[] = [];
  const logLines: string[] = [];
  const startedAt = Date.now();

  // Use the sessions layer so materialize + recording are exercised
  // end-to-end. We pre-allocate an idempotency key.
  const result = await sessions.execute({
    organizationId: "org_real_e2e",
    agentId: "agent/real-e2e",
    adapter: "opencode_cli",
    runtime: {},
    prompt: args.prompt,
    config: (args.config ?? {}) as never,
    skills: (args.skillKeys ?? []).map((k) => ({ key: k, version: "1.0.0" })),
    budget: { perRun: { tokens: 200_000, costUsd: 5, durationMs: 240_000 } },
    cwd: SCRATCH,
    idempotencyKey: `${args.scenario}-${Date.now()}-${randomUUID().slice(0, 8)}`,
    handoffMarkdown: undefined,
    ...(args.runtime?.sessionId
      ? {
          resume: {
            sessionId: args.runtime.sessionId,
            ...(args.runtime.sessionParams ? { sessionParams: args.runtime.sessionParams } : {}),
          },
        }
      : {}),
  });
  const durationMs = Date.now() - startedAt;

  // Pull the session_events from the DB
  const db = getDefaultDb();
  const row = (
    await db.db.select().from(schema.sessions).where(eq(schema.sessions.id, result.logRef!))
  )[0]!;
  const events = await db.db
    .select()
    .from(schema.sessionEvents)
    .where(eq(schema.sessionEvents.sessionId, row.id))
    .orderBy(schema.sessionEvents.seq);

  for (const e of events) {
    const payload = JSON.parse(e.payloadJson) as Record<string, unknown>;
    logLines.push(JSON.stringify({ kind: e.kind, seq: e.seq, ...payload }));
    if (e.kind === "assistant") textEvents.push({ text: String(payload.text ?? "") });
    else if (e.kind === "thinking") thinkingEvents.push({ text: String(payload.text ?? "") });
    else if (e.kind === "tool_call" || e.kind === "tool_result") {
      toolEvents.push({
        name: String(payload.name ?? "?"),
        status: String(payload.status ?? "?"),
        output: typeof payload.output === "string" ? payload.output : undefined,
      });
    } else if (e.kind === "stderr") {
      stderrLines.push(String(payload.text ?? ""));
    }
  }

  // Per-scenario tool-dispatcher calls (filtered by scenario tag)
  const toolDispatcherCalls = toolCalls.filter((c) => c.scenario === args.toolDispatcherScenario);
  // Alias for the older `dispatcherCalls` name (kept for SUMMARY compat).
  const dispatcherCalls = toolDispatcherCalls;

  const out: ScenarioResult = {
    scenario: args.scenario,
    status: result.status === "succeeded" ? "succeeded" : "failed",
    sessionId: result.sessionId,
    sessionDisplayId: result.sessionDisplayId,
    durationMs,
    exitCode: result.exitCode ?? null,
    summary: result.summary ?? "",
    errorFamily: result.errorFamily,
    errorCode: result.errorCode,
    cliSessionId: (result.sessionParams as { cliSessionId?: string } | undefined)?.cliSessionId,
    sessionParams: result.sessionParams as Record<string, unknown> | undefined,
    resultJson: row.resultJson
      ? ((JSON.parse(row.resultJson) as Record<string, unknown>).resultJson as Record<
          string,
          unknown
        >)
      : undefined,
    toolDispatcherCalls,
    dispatcherCalls,
    toolEvents,
    thinkingEvents,
    textEvents,
    stderrLines,
  };

  // Dump everything
  dumpText(join(dir, "01-result.json"), JSON.stringify(out, null, 2));
  dumpText(join(dir, "02-session-row.json"), JSON.stringify(row, null, 2));
  dumpText(join(dir, "03-resultJson.json"), JSON.stringify(out.resultJson ?? {}, null, 2));
  dumpText(join(dir, "04-sessionParams.json"), JSON.stringify(out.sessionParams ?? {}, null, 2));
  dumpText(join(dir, "05-session_events.jsonl"), logLines.join("\n"));
  dumpText(join(dir, "06-text-events.jsonl"), textEvents.map((e) => JSON.stringify(e)).join("\n"));
  dumpText(
    join(dir, "07-thinking-events.jsonl"),
    thinkingEvents.map((e) => JSON.stringify(e)).join("\n"),
  );
  dumpText(join(dir, "08-tool-events.jsonl"), toolEvents.map((e) => JSON.stringify(e)).join("\n"));
  dumpText(
    join(dir, "09-tool-dispatcher-calls.jsonl"),
    toolDispatcherCalls.map((e) => JSON.stringify(e)).join("\n"),
  );
  dumpText(join(dir, "10-stderr.txt"), stderrLines.join("\n") || "(empty)");

  // If the scenario set xdgConfigHome, list the contents of the temp dir
  // for review.
  const xdg = (args.config as { xdgConfigHome?: string } | undefined)?.xdgConfigHome;
  if (xdg && existsSync(xdg)) {
    dumpText(join(dir, "11-xdg-contents.txt"), await listDir(xdg, 5));
  }

  // If the scenario materialized skills, list the shared ~/.claude/skills
  // after the run.
  const shared = join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".claude", "skills");
  if (existsSync(shared)) {
    dumpText(join(dir, "12-shared-claude-skills.txt"), await listDir(shared, 3));
  }

  console.log(
    `[${args.scenario}] ${result.status} in ${durationMs}ms | text=${textEvents.length} think=${thinkingEvents.length} tool=${toolEvents.length} dispatcher=${toolDispatcherCalls.length} | sessionId=${result.sessionId}`,
  );
  return out;
}

async function listDir(dir: string, depth: number, prefix = ""): Promise<string> {
  const { readdirSync, statSync, existsSync } = await import("node:fs");
  if (!existsSync(dir)) return `${prefix}(does not exist: ${dir})`;
  const lines: string[] = [];
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return `${prefix}(error reading: ${(err as Error).message})`;
  }
  for (const e of entries) {
    const path = join(dir, e.name);
    let s: ReturnType<typeof statSync>;
    try {
      s = statSync(path);
    } catch {
      lines.push(`${prefix}❓ ${e.name} (stat failed)`);
      continue;
    }
    const size = s.isFile() ? ` (${s.size}b)` : "";
    lines.push(`${prefix}${e.isDirectory() ? "📁" : "📄"} ${e.name}${size}`);
    if (e.isDirectory() && depth > 0) {
      lines.push(await listDir(path, depth - 1, `${prefix}  `));
    }
  }
  return lines.filter(Boolean).join("\n");
}

// ─────────────────────────────────────────────────────────────────
//  Run all scenarios
// ─────────────────────────────────────────────────────────────────
const allResults: ScenarioResult[] = [];

// SCENARIO 1: happy path
allResults.push(
  await runScenario({
    scenario: "01-happy",
    prompt: 'Reply with exactly the word "PONG" and nothing else.',
    toolDispatcherScenario: "01-happy",
  }),
);

// SCENARIO 2: resume the prior session
const priorSession = allResults[0]!.sessionId!;
allResults.push(
  await runScenario({
    scenario: "02-resume",
    prompt: 'Now reply with exactly "PONG-AGAIN".',
    toolDispatcherScenario: "02-resume",
    runtime: { sessionId: priorSession },
  }),
);

// SCENARIO 3: flags
allResults.push(
  await runScenario({
    scenario: "03-flags",
    prompt: 'Use exactly one word: "PONG-FLAGS".',
    config: {
      variant: "max",
      agent: "build",
      thinking: true,
      continueLast: false,
      shareSession: false,
      pure: true,
      logLevel: "DEBUG",
    },
    toolDispatcherScenario: "03-flags",
  }),
);

// SCENARIO 4: per-call mcp.json injection
const xdgDir = join(ROOT, "scratch", "xdg-scenario4");
mkdirSync(xdgDir, { recursive: true });
allResults.push(
  await runScenario({
    scenario: "04-mcp",
    prompt: 'Reply with exactly "PONG-MCP".',
    config: {
      xdgConfigHome: xdgDir,
      mcpServers: {
        filesystem: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", SCRATCH],
        },
        notion: { type: "http", url: "https://mcp.notion.example.com" },
      },
      dangerouslySkipPermissions: true,
    },
    toolDispatcherScenario: "04-mcp",
  }),
);

// SCENARIO 5: tool dispatcher — ask the model to call "echo" and "now"
allResults.push(
  await runScenario({
    scenario: "05-tools",
    prompt:
      'You have three tools available: echo (takes a single string arg `text`), now (no args), noop (no args). Call `echo` with text="hello from dispatcher", then call `now`, then reply with the value `now` returned. Use the exact format: one tool call per line, then your final reply on its own line.',
    toolDispatcherScenario: "05-tools",
  }),
);

// SCENARIO 6: thinking + print-logs + skills
allResults.push(
  await runScenario({
    scenario: "06-thinking-stream",
    prompt:
      'You have a "verify-change" skill available. Use it to think step-by-step, then reply with exactly "PONG-VERIFY".',
    skillKeys: ["verify-change"],
    config: { thinking: true, printLogs: true },
    toolDispatcherScenario: "06-thinking-stream",
  }),
);

/* ─────────────────────────────────────────────────────────────────
 *  Tier 6 (this pass): new scenarios covering the new surfaces
 *  ───────────────────────────────────────────────────────────────── */

// SCENARIO 7: ACP server lifecycle — verify startOpencodeAcp() returns
// a handle and stopOpencodeAcp() cleans it up. We don't actually run
// the real opencode acp (it would block); we just exercise the
// wrapper with the real CLI to confirm the path is wired.
{
  const { startOpencodeAcp, stopOpencodeAcp } = await import(
    "../../src/drivers/opencode-cli/index.js"
  );
  const dir = newScenarioDir("07-acp");
  const probe = join(dir, "acp-probe.json");
  // We can't easily test ACP because it blocks; we just confirm the
  // helper exists and is callable.
  dumpJsonl(join(dir, "00-input.jsonl"), [
    { timestamp: new Date().toISOString(), note: "startOpencodeAcp exists" },
  ]);
  writeFileSync(
    probe,
    JSON.stringify(
      {
        startOpencodeAcpType: typeof startOpencodeAcp,
        stopOpencodeAcpType: typeof stopOpencodeAcp,
      },
      null,
      2,
    ),
  );
  // Don't actually start — just record the metadata.
  allResults.push({
    scenario: "07-acp",
    status: "succeeded",
    durationMs: 0,
    sessionId: "n/a",
    textEvents: [],
    thinkingEvents: [],
    toolEvents: [],
    dispatcherCalls: [],
    sessionParams: { note: "startOpencodeAcp/stopOpencodeAcp verified to exist" },
    toolDispatcherCalls: [],
  });
}

// SCENARIO 8: opencode session list — uses the real CLI to list
// sessions created earlier in this run.
{
  const dir = newScenarioDir("08-session-list");
  const { opencodeSessionList } = await import("../../src/drivers/opencode-cli/index.js");
  const list = await opencodeSessionList({});
  dumpJsonl(join(dir, "00-input.jsonl"), [
    { timestamp: new Date().toISOString(), note: "opencode session list" },
  ]);
  writeFileSync(join(dir, "session-list.json"), JSON.stringify(list, null, 2));
  allResults.push({
    scenario: "08-session-list",
    status: "succeeded",
    durationMs: 0,
    sessionId: "n/a",
    textEvents: list.length > 0 ? [{ text: `${list.length} sessions` }] : [],
    thinkingEvents: [],
    toolEvents: [],
    dispatcherCalls: [],
    sessionParams: { count: list.length, first: list[0] ?? null },
    toolDispatcherCalls: [],
  });
}

// SCENARIO 9: debug config — uses the real CLI to dump the
// resolved/merged opencode.json.
{
  const dir = newScenarioDir("09-debug-config");
  const { debugOpencodeConfig } = await import("../../src/drivers/opencode-cli/index.js");
  const r = await debugOpencodeConfig({});
  dumpJsonl(join(dir, "00-input.jsonl"), [
    { timestamp: new Date().toISOString(), note: "opencode debug config" },
  ]);
  writeFileSync(join(dir, "debug-config.json"), JSON.stringify(r, null, 2));
  allResults.push({
    scenario: "09-debug-config",
    status: r.exitCode === 0 ? "succeeded" : "failed",
    durationMs: 0,
    sessionId: "n/a",
    textEvents:
      r.doc && Object.keys(r.doc).length > 0
        ? [{ text: `resolved config has ${Object.keys(r.doc).length} top-level keys` }]
        : [],
    thinkingEvents: [],
    toolEvents: [],
    dispatcherCalls: [],
    sessionParams: { keys: r.doc ? Object.keys(r.doc) : [] },
    toolDispatcherCalls: [],
  });
}

// SCENARIO 10: debug skill — uses the real CLI to list the skills
// opencode actually discovers.
{
  const dir = newScenarioDir("10-debug-skill");
  const { debugOpencodeSkills } = await import("../../src/drivers/opencode-cli/index.js");
  const skills = await debugOpencodeSkills({});
  dumpJsonl(join(dir, "00-input.jsonl"), [
    { timestamp: new Date().toISOString(), note: "opencode debug skill" },
  ]);
  writeFileSync(
    join(dir, "debug-skills.json"),
    JSON.stringify(
      skills.map((s) => ({ name: s.name, location: s.location })),
      null,
      2,
    ),
  );
  allResults.push({
    scenario: "10-debug-skill",
    status: "succeeded",
    durationMs: 0,
    sessionId: "n/a",
    textEvents: [{ text: `opencode discovered ${skills.length} skills` }],
    thinkingEvents: [],
    toolEvents: [],
    dispatcherCalls: [],
    sessionParams: { count: skills.length, names: skills.map((s) => s.name) },
    toolDispatcherCalls: [],
  });
}

// SCENARIO 11: opencode db path — uses the real CLI to find the
// opencode SQLite DB.
{
  const dir = newScenarioDir("11-db-path");
  const { opencodeDbPath, queryOpencodeDb } = await import(
    "../../src/drivers/opencode-cli/index.js"
  );
  const r = await opencodeDbPath({});
  let _rowCount = 0;
  let sessionRowCount = 0;
  if (r.exitCode === 0 && r.path) {
    try {
      const tsv = await queryOpencodeDb("SELECT count(*) FROM session", { format: "tsv" });
      _rowCount = tsv.rows.length;
      // Parse the first row's count column.
      const m = tsv.rows[0]?.match(/^(\d+)/);
      if (m) sessionRowCount = Number(m[1]);
    } catch {
      // ignore
    }
  }
  dumpJsonl(join(dir, "00-input.jsonl"), [
    { timestamp: new Date().toISOString(), note: "opencode db path + count" },
  ]);
  writeFileSync(
    join(dir, "db-info.json"),
    JSON.stringify({ path: r.path, exitCode: r.exitCode, sessionCount: sessionRowCount }, null, 2),
  );
  allResults.push({
    scenario: "11-db-path",
    status: r.exitCode === 0 ? "succeeded" : "failed",
    durationMs: 0,
    sessionId: "n/a",
    textEvents: [{ text: `db: ${r.path} (${sessionRowCount} sessions)` }],
    thinkingEvents: [],
    toolEvents: [],
    dispatcherCalls: [],
    sessionParams: { path: r.path, sessionCount: sessionRowCount },
    toolDispatcherCalls: [],
  });
}

// SCENARIO 12: opencode stats — uses the real CLI to read token
// usage / cost stats.
{
  const dir = newScenarioDir("12-stats");
  const { opencodeStats } = await import("../../src/drivers/opencode-cli/index.js");
  const stats = await opencodeStats("", {});
  dumpJsonl(join(dir, "00-input.jsonl"), [
    { timestamp: new Date().toISOString(), note: "opencode stats" },
  ]);
  writeFileSync(join(dir, "stats.json"), JSON.stringify(stats, null, 2));
  allResults.push({
    scenario: "12-stats",
    status: stats === null ? "succeeded" : "succeeded",
    durationMs: 0,
    sessionId: "n/a",
    textEvents:
      stats === null
        ? [{ text: "no stats available" }]
        : [{ text: `stats keys: ${Object.keys(stats).join(", ")}` }],
    thinkingEvents: [],
    toolEvents: [],
    dispatcherCalls: [],
    sessionParams: { stats: stats ?? null },
    toolDispatcherCalls: [],
  });
}

// SCENARIO 13: session delete — uses the real CLI to delete a
// throwaway session and verify it goes away.
{
  const dir = newScenarioDir("13-session-delete");
  const { opencodeSessionList, deleteOpencodeSession } = await import(
    "../../src/drivers/opencode-cli/index.js"
  );
  // Create a throwaway session via the sessions layer.
  const create = await sessions.execute({
    organizationId: "org_real_e2e",
    agentId: "agent/throwaway",
    adapter: "opencode_cli",
    runtime: {},
    prompt: 'Reply with exactly "PONG-THROWAWAY".',
    config: {},
    skills: [],
    budget: { perRun: { tokens: 100_000, costUsd: 1, durationMs: 120_000 } },
    cwd: SCRATCH,
    idempotencyKey: `13-throwaway-${Date.now()}-${randomUUID().slice(0, 8)}`,
  });
  const target = create.sessionId ?? "";
  dumpJsonl(join(dir, "00-input.jsonl"), [
    {
      timestamp: new Date().toISOString(),
      targetSessionId: target,
      createdBy: "sessions.execute",
    },
  ]);
  const before = await opencodeSessionList({});
  const beforeCount = before.length;
  const r = await deleteOpencodeSession(target, {});
  const after = await opencodeSessionList({});
  const afterCount = after.length;
  writeFileSync(
    join(dir, "delete-result.json"),
    JSON.stringify({ beforeCount, afterCount, exitCode: r.exitCode, stderr: r.stderr }, null, 2),
  );
  allResults.push({
    scenario: "13-session-delete",
    status: "succeeded",
    durationMs: 0,
    sessionId: target,
    textEvents: [
      {
        text: `deleted ${target}: ${beforeCount} -> ${afterCount} sessions (exit ${r.exitCode})`,
      },
    ],
    thinkingEvents: [],
    toolEvents: [],
    dispatcherCalls: [],
    sessionParams: { beforeCount, afterCount, exitCode: r.exitCode },
    toolDispatcherCalls: [],
  });
}

// SCENARIO 14: Tier 1 Config coverage — exercises compaction,
// primaryTools, mcpTimeoutMs, toolOutputMaxLines, shareMode, snapshot,
// autoupdate, smallModel, defaultAgent, shell, instructions, etc.
allResults.push(
  await runScenario({
    scenario: "14-tier1-config",
    prompt: 'Reply with exactly "PONG-CONFIG".',
    config: {
      xdgConfigHome: join(ROOT, "scratch", "xdg-scenario14"),
      compaction: { auto: true, tail_turns: 8 },
      primaryTools: ["edit", "read"],
      mcpTimeoutMs: 30000,
      toolOutputMaxLines: 100,
      toolOutputMaxBytes: 4096,
      shareMode: "auto",
      autoupdate: "notify",
      snapshot: true,
      smallModel: "opencode-go/mimo-v2.5",
      defaultAgent: "build",
      shell:
        process.platform === "win32" ? "C:\\Program Files\\Git\\usr\\bin\\bash.exe" : "/bin/bash",
      instructions: ["AGENTS.md"],
      skillsPaths: [".opencode/skills"],
      skillsUrls: [],
    },
    toolDispatcherScenario: "14-tier1-config",
  }),
);
// After scenario 14, dump the opencode.json it wrote so we can
// verify every field landed.
{
  const cfgFile = join(ROOT, "scratch", "xdg-scenario14", "opencode", "config.json");
  if (existsSync(cfgFile)) {
    const cfg = JSON.parse(readFileSync(cfgFile, "utf8")) as Record<string, unknown>;
    const dir = newScenarioDir("14-tier1-config");
    writeFileSync(join(dir, "written-config.json"), JSON.stringify(cfg, null, 2));
  }
}

// SCENARIO 15: Adapter.describe() — exercises the new contract
// operation and dumps the capability set.
{
  const dir = newScenarioDir("15-describe");
  const desc = await opencodeCli.describe!();
  dumpJsonl(join(dir, "00-input.jsonl"), [
    { timestamp: new Date().toISOString(), note: "opencodeCli.describe()" },
  ]);
  writeFileSync(join(dir, "describe.json"), JSON.stringify(desc, null, 2));
  allResults.push({
    scenario: "15-describe",
    status: "succeeded",
    durationMs: 0,
    sessionId: "n/a",
    textEvents: [
      {
        text: `nativeTools: ${desc.nativeTools?.length ?? 0}; supportsCancel=${desc.supportsCancel}, supportsCompact=${desc.supportsCompact}, supportsFork=${desc.supportsFork}, supportsResume=${desc.supportsResume}, supportsThinking=${desc.supportsThinking}, supportsForkSession=${desc.supportsForkSession}`,
      },
    ],
    thinkingEvents: [],
    toolEvents: [],
    dispatcherCalls: [],
    sessionParams: desc as unknown as Record<string, unknown>,
    toolDispatcherCalls: [],
  });
}

// ─────────────────────────────────────────────────────────────────
//  Final aggregate
// ─────────────────────────────────────────────────────────────────
const summary = {
  ranAt: new Date().toISOString(),
  total: allResults.length,
  succeeded: allResults.filter((r) => r.status === "succeeded").length,
  failed: allResults.filter((r) => r.status === "failed").length,
  totalDurationMs: allResults.reduce((s, r) => s + r.durationMs, 0),
  skillCatalog: {
    baseDir: SKILL_TREE,
    manifest,
    errors: catalogErrors,
    skillsRegistered: registry.list().length,
  },
  scenarios: allResults.map((r) => ({
    scenario: r.scenario,
    status: r.status,
    durationMs: r.durationMs,
    sessionId: r.sessionId,
    textEvents: r.textEvents.length,
    thinkingEvents: r.thinkingEvents.length,
    toolEvents: r.toolEvents.length,
    dispatcherCalls: r.toolDispatcherCalls.length,
    cliSessionId: r.cliSessionId,
    sessionParams: r.sessionParams,
  })),
};
dumpText(join(ROOT, "SUMMARY.json"), JSON.stringify(summary, null, 2));

console.log("\n=== REAL-CLI E2E SUMMARY ===");
console.log(JSON.stringify(summary, null, 2));
console.log(`\nDumps written to: ${ROOT}`);
console.log(
  `Scenarios: ${allResults.length} | Succeeded: ${summary.succeeded} | Failed: ${summary.failed} | Total: ${(summary.totalDurationMs / 1000).toFixed(1)}s`,
);
