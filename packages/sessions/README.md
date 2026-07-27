# `@aaspai/sessions`

The orchestration layer. Composes a `@aaspai/harness` adapter
(`opencode_cli`, `claude_local`, …), the agent's resolved config, knowledge,
skills, and resume state into a single `execute(req)` call. Persists every
session to the DB and streams events back through the caller's callbacks.

## What it does, in one diagram

```
SessionRequest ──► Sessions.execute()
                       │
                       ├── agentSource.get(agentId)        ← who to run
                       ├── knowledgeLoader.loadFor(agent)  ← what they know
                       ├── skillRegistry (per skill)        ← what they can do
                       │
                       ├── compose full prompt
                       │     (systemPrompt + cli hint + skills + prompt + knowledge)
                       │
                       ├── insert session row (status="running")
                       │
                       ├── adapter.execute(ctx)            ← actual run
                       │     └─ emits transcript → session_events (kind: assistant|thinking|tool_call|…)
                       │
                       ├── reclassify errorFamily (auth / provider_quota / transient_upstream / internal)
                       │
                       └── update session row (status="succeeded"|"failed"|"timed_out")
                             + persist adapter's errorMessage into the errorMessage column
```

---

## Package surface

### Public exports (`@aaspai/sessions`)

```ts
import { Sessions, type SessionsOptions } from "@aaspai/sessions";
```

### Subpath exports

| Subpath                | What it re-exports                |
| ---------------------- | --------------------------------- |
| `@aaspai/sessions`     | `Sessions`, `SessionsOptions`     |
| `@aaspai/sessions/sessions` | the `Sessions` class        |
| `@aaspai/sessions/lifecycle` | (planned) pause/resume/stop/cancel helpers |

### Scripts

| Script            | What it does                                              |
| ----------------- | --------------------------------------------------------- |
| `pnpm test`       | Full vitest suite (~30 s) — unit + 13 e2e tests           |
| `pnpm test:e2e`   | Only the `describe("e2e: …")` blocks                     |
| `pnpm typecheck`  | `tsc --noEmit`                                           |
| `pnpm lint`       | biome check                                              |

---

## API

### `new Sessions({ agentSource, knowledgeSource, skillRegistry })`

```ts
const sessions = new Sessions({
  agentSource: buildAgentSource(agent),          // AgentConfigSource port
  knowledgeSource: buildKnowledgeSource(),        // KnowledgeSource port
  skillRegistry: new SkillRegistry(),            // SkillRegistry
});
await sessions.start();                          // optional; warms up sources
```

`start()` is idempotent and safe to call multiple times. It calls
`source.start()` on any source that exposes one (e.g. the file-based
`KnowledgeLoader`'s chokidar scan).

### `sessions.execute(req): Promise<SessionResult>`

```ts
const result = await sessions.execute({
  organizationId: "org_…",
  agentId:        "agent/<slug>",
  adapter:        "opencode_cli" | "claude_local" | …,
  runtime:        {},                 // ExecutionTarget (foundation slice: empty {})
  prompt:         "free-form text",   // 1-1 MB
  config:         {},                 // per-call adapter config overrides
  skills:         [{ key, version }], // resolved via skillRegistry
  resume:         {                   // optional: continue a prior session
    sessionId:    "ses_…",
    sessionParams: {},
    context:      "free-form text",   // prepended as '## Wakeup context' on resume
  },
  budget:         {                   // per-run limits (Priority 8)
    perRun: { tokens, costUsd, durationMs },
  },
  cwd:            "/abs/path",        // optional; defaults to process.cwd()
  attachments:    [],                 // optional
  handoffMarkdown: "## Handoff\n…",   // appended to summary on success
  parentSessionId: "sess_…",          // persisted into sessions.parent_session_id
  idempotencyKey: "string",           // required (caller chooses)
  traceId:        "agent/run/123",    // optional
  wakeupId:       "wakeup_…",         // optional; defaults to "manual"
});
```

### `SessionResult` shape

| Field              | Source                                                            |
| ------------------ | ----------------------------------------------------------------- |
| `sessionId`        | the adapter's session id (e.g. `ses_…`), or the aaspai session id if the adapter didn't surface one |
| `sessionDisplayId` | first 12 chars of `sessionId`                                    |
| `sessionParams`    | the adapter's sessionParams (`{ model, cli, resume, fork }` for opencode-cli) |
| `status`           | `"succeeded"` / `"failed"` / `"timed_out"`                        |
| `exitCode`         | `0` for success, the child's exit code (or `null` if killed) for failure |
| `usage`            | `{ inputTokens, outputTokens, cachedInputTokens }` from the adapter |
| `costUsd`          | total cost if the adapter reported it                             |
| `errorFamily`      | reclassified: `auth` / `provider_quota` / `transient_upstream` / `internal` / `model_refusal` / `config` / `user_cancelled` |
| `errorCode`        | stable string identifier (`opencode_cli_failed` / `killed_by_signal` / `timeout` / `adapter_execution_failed` / …) |
| `summary`          | the assistant's text; falls back to the adapter's `errorMessage` for failures, then to the `errorCode` |
| `question`         | the agent's pending question (foundation slice: not yet used)       |
| `logRef`           | the aaspai session id (foreign key into the `sessions` table)      |

### `sessions.get(id) / sessions.list() / sessions.pause/resume/stop/cancel(id)`

Read-side and lifecycle methods. All delegate to Drizzle queries against the
`sessions` table. Foundation slice:
- `get(id)` returns the row parsed through `sessionStateSchema` (Drizzle → zod)
- `list()` returns all rows, ordered by `startedAt`
- `pause(id, reason)` flips status to `paused_for_question` and records a
  `pendingQuestionJson` blob
- `resume(id, _answer?)` flips status back to `running` and clears
  `pendingQuestionJson` (the re-execute is a Phase 4 concern)
- `stop(id, reason)` and `cancel(id, reason)` set status to `cancelled` and
  store the reason in `errorMessage`

---

## How the session is composed

### Prompt composition (the system-prompt chain)

`Sessions.execute()` builds the prompt the adapter receives in five layers,
each separated by `\n\n---\n\n` (which the `dry_run_local` adapter parses
explicitly):

```
<systemPrompt>                          ← from agent.systemPrompt
\n\n---\n\n
<aaspai CLI hint>                       ← if AASPAI_CLI_PATH is set
\n\n---\n\n
<skill instructions joined>            ← resolved via skillRegistry
\n\n---\n\n
<req.prompt>                           ← the user's input
\n\n---\n\n
<knowledge.context>                    ← from KnowledgeLoader.loadFor(agent)
```

### Knowledge loading

`KnowledgeLoader.loadFor(agent)` (from `@aaspai/knowledge`) expands the
agent's `knowledge.include` globs, drops any path in `knowledge.exclude`,
loads each concept, and concatenates the bodies. Default caps: 50 concepts,
100 KB of context.

### Skill resolution

For each `req.skills[i]`, we look up the `SkillRegistry` for the matching
`{ key, version }`. We push `${skill.name}\n\n${skill.instructions}` into
the prompt, AND we call `skillRegistry.materialize(resolvedSkills, {…})` to
write the SKILL.md + side files to the adapter's runtime dir so the
adapter can discover them on disk.

For the `opencode_cli` and `claude_local` adapters we use
`sharedHome: true` (writes to `~/.claude/skills`, the opencode CLI's
default skills home) and `symlink: true` (so aaspai's cache under
`.aaspai/skills/<key>/` stays the single source of truth). For other
adapters we write to `<cwd>/.<adapter>/skills/<key>/`. `verifySha256: true`
is the default — every file's `sha256` (if set on the Skill) is checked
before the file is written; a mismatch is reported as an error and the
file is skipped. Pinned by
`materializes req.skills[].key into <cwd>/.opencode_cli/skills/<key>/SKILL.md before execute`.

`SkillCatalog` (in `@aaspai/skills`) builds a registry from a
`catalog/{bundled,optional}/<category>/<slug>/` tree and supports
GitHub-pinned skills via `catalog-ref.json`. The catalog's manifest
shape mirrors `@paperclipai/skills-catalog` closely enough that the
same JSON can be consumed by either system.

### Agent config composition

`agentAdapterConfig(agent)` returns the per-call adapter config:

```ts
{
  ...(agent.model ? { model: agent.model } : {}),
  ...agent.adapterConfig,            // per-agent adapter overrides
}
```

Then `executionConfig = { ...agentAdapterConfig(agent), ...(req.config ?? {}) }`.
Per-call `req.config` wins over per-agent defaults.

### Resuming a session

Set `req.resume = { sessionId, sessionParams? }`. The `Sessions` layer
translates this to `ctx.runtime.sessionId`. The `opencode_cli` adapter then
forwards `--session <id>` (and `--fork` if `sessionParams.fork === true`)
to the opencode CLI. The aaspai session row gets the same `sessionId` on
the next run.

**Wake-up delta** (Priority 7): if you also pass `req.resume.context`,
the sessions layer prepends it to the prompt as a `## Wakeup context`
block, ordered **before** the user's new prompt. Use this to inject
"the user said X in chat while you were away" without making the
model think the new ask is X.

```ts
const result = await sessions.execute({
  // …
  resume: {
    sessionId: "ses_old",
    context: "The user said: please also do Y",
  },
  prompt: "do the next thing",  // appended AFTER the wakeup context
});
```

### Handoff markdown (Priority 7)

If you pass `req.handoffMarkdown`, the sessions layer appends it to the
assistant's `summary` on success (separated by `\n\n---\n\n`). The next
agent that resumes this session sees the handoff note at the tail of
the previous session's output.

```ts
const result = await sessions.execute({
  // …
  handoffMarkdown: "## Handoff\n\nnext agent should do Y",
});
// result.summary === assistantText + "\n\n---\n\n## Handoff\n\nnext agent should do Y"
```

### Budget enforcement (Priority 8)

`req.budget.perRun` lets you cap a single session's resource use:

```ts
{
  budget: {
    perRun: { tokens: 50_000, costUsd: 1.0, durationMs: 120_000 },
  },
}
```

When any hard limit is exceeded, the run is marked `failed` with:

- `errorFamily: "user_cancelled"`
- `errorCode: "budget_exceeded:tokens" | "budget_exceeded:costUsd" | "budget_exceeded:durationMs"`
- The persisted `errorMessage` column gets a human-readable
  `"Budget exceeded: tokens (limit 50000, actual 51200)"` string.

Soft limits (the `soft` / `hard` fractions on the full `Budget` object)
are advisory for the UI and not enforced here.

### Parent / child sessions (Priority 8)

`req.parentSessionId` is persisted into the `sessions.parent_session_id`
column so the UI can render a session tree.

```ts
const child = await sessions.execute({
  // …
  parentSessionId: "sess_parent_42",
  prompt: "child does its work",
});
```

---

## Error handling — the reclassifier

`Sessions.execute()` calls `classifyErrorFamily(adapterErrorFamily, message, errorCode)`
on both the success and the catch path. The classifier upgrades a generic
`internal` family to a specific one when the message matches a known
pattern, regardless of whether the adapter threw or returned.

| Pattern (case-insensitive)              | errorFamily          |
| --------------------------------------- | -------------------- |
| `auth|api key|unauthor`                 | `auth`               |
| `quota|rate limit`                      | `provider_quota`     |
| `timeout|timed out|killed by sigterm|killed by sigkill` | `transient_upstream` |
| `errorCode === "killed_by_signal"` or `"timeout"` | `transient_upstream` |

`errorFamily` is also persisted to the `sessions.errorFamily` column and to
`resultJson` so consumers can route retries accordingly.

### Persisted errorMessage column

The `sessions.errorMessage` column is populated with the first of:

1. `adapterResult.errorMessage` — the actual reason the run failed (sourced
   from stderr or the JSON error event by the adapter)
2. `result.summary` — the assistant's text (usually empty for failures)
3. `result.errorCode` — a stable string identifier
4. the literal `"failed"` so the column is never `NULL`

For successful sessions the column is left `NULL`.

---

## Comparison: aaspai vs paperclip

> **Note on paperclip references.** Paperclip is referenced throughout this
> README purely for **study and comparison** — it is a separate project
> (not a dependency, not a competitor, not a target we're trying to
> match one-for-one). It is included as a useful "what does a more
> elaborate orchestrator look like" reference. The honest truth is that
> aaspai is the smaller, more opinionated package: ~488 lines vs
> paperclip's 800+ across the two files. We borrow ideas (the compose
> pipeline shape, the JSON-event reclassifier) but not scope. Source:
> `study/paperclip/` in this repo. The `AGENTS.md` there is authoritative
> for that project; the `aaspai/AGENTS.md` is authoritative for this one.

paperclip's `execute.ts` (719 lines) and `parse.ts` (101 lines) are
significantly more elaborate than aaspai's `sessions.ts` (488 lines) because
they have to support remote/sandbox execution targets. This table is the
honest comparison — every column reflects what is actually in the code today.

### Compose path

| Step                          | aaspai                                                              | paperclip (`execute.ts`)                                                           |
| ----------------------------- | :-----------------------------------------------------------------: | :---------------------------------------------------------------------------------: |
| Resolve agent                 | `agentSource.get(agentId)`                                            | `agent` passed via `ctx`                                                            |
| Compose config                | `{ ...agentAdapterConfig(agent), ...req.config }`                    | `executionConfig = { ...config, ...rendered, ...extras }` (template-rendered)         |
| Prompt template               | ❌                                                                  | ✅ (`renderTemplate(bootstrapPromptTemplate, templateData)`)                         |
| Wake prompt delta             | ❌                                                                  | ✅ (`renderPaperclipWakePrompt`)                                                     |
| Handoff note                  | ❌                                                                  | ✅ (`context.paperclipSessionHandoffMarkdown`)                                        |
| Instructions file             | ❌                                                                  | ✅ (`config.instructionsFilePath` → file contents prepended)                         |
| CLI hint                      | ✅ (`AASPAI_CLI_PATH` env)                                            | ❌                                                                                  |
| Skills injection               | ✅ (`## Skill: ${name}\n\n${instructions}` joined)                    | ✅ (`ensurePaperclipSkillSymlink` + `readPaperclipRuntimeSkillEntries`)             |
| Knowledge injection            | ✅ (`\n\n---\n\n${context}`)                                            | ✅ (via `prepareOpenCodeRuntimeConfig` + sandbox upload)                              |
| Resume delta                   | ❌ (use `--session` + `--fork`)                                      | ✅ (`--session` + auto-retry on `unknown_session`)                                   |

### Recording path

| Step                          | aaspai                                                              | paperclip                                                                   |
| ----------------------------- | :-----------------------------------------------------------------: | :--------------------------------------------------------------------------: |
| Insert session row            | ✅ (status="running")                                                 | ✅ (status="queued" → "running" via `EXECUTION_REPOSITORY`)                  |
| Record session_events          | ✅ (every transcript line, monotonic seq)                              | ✅ (via session_events repository)                                            |
| Result schema                 | `SessionResult` (phase2)                                            | `AdapterExecutionResult` (forwarded as-is to the client)                    |
| `resultJson` persistence      | ✅                                                                  | ✅                                                                          |
| `usageJson` persistence        | ✅                                                                  | ✅                                                                          |
| `costUsd` persistence          | ✅                                                                  | ✅                                                                          |
| `errorFamily` persistence      | ✅ (reclassified)                                                    | ✅ (as-returned by the adapter; no reclassifier)                            |
| `errorMessage` column          | ✅ (`adapterResult.errorMessage` → `summary` → `errorCode` → `"failed"`) | ✅ (`errorMessage` from adapter; "errorMessage" written from adapter directly) |

### Lifecycle methods

| Method         | aaspai                                | paperclip (loops/wakeups/sessions repositories)        |
| -------------- | :-----------------------------------: | :----------------------------------------------------: |
| `get(id)`      | ✅ (one row, parsed via `sessionStateSchema`) | ✅ (one row)                                    |
| `list()`       | ✅ (ordered by `startedAt`)              | ✅ (filtered by company)                            |
| `pause(id, …)` | ✅ (`status="paused_for_question"`, `pendingQuestionJson` set) | ✅ (same)                                |
| `resume(id, …)` | ✅ (status flips back; re-execute is Phase 4) | ✅ (re-execute is wired)                        |
| `stop(id, …)`   | ✅ (status="cancelled", errorMessage="Stopped: <reason>") | ✅ (similar)                              |
| `cancel(id, …)` | ✅ (status="cancelled", errorMessage="Cancelled: <reason>") | ✅ (similar)                            |

### Adapter errorFamily vocabulary

| Value              | aaspai source                                  | paperclip source                                |
| ------------------ | ---------------------------------------------- | ----------------------------------------------- |
| `auth`             | `classifyErrorFamily` regex + adapter return    | adapter return (no reclassifier)                |
| `provider_quota`   | `classifyErrorFamily` regex + adapter return    | adapter return                                  |
| `transient_upstream` | `classifyErrorFamily` regex + adapter return (timeout, signal) | adapter return (timeout)             |
| `model_refusal`    | (defined in schema, not yet set)                | (defined in schema)                              |
| `config`           | (defined in schema, not yet set)                | (defined in schema)                              |
| `internal`         | default (when no pattern matches)                | default                                          |
| `user_cancelled`   | (defined in schema, not yet set)                | (defined in schema)                              |

---

## E2E test surface

24 tests in `__tests__/e2e.test.ts` + `__tests__/sessions.test.ts` cover:

| Test name | What it pins |
| --------- | ------------ |
| `records a session row, session_events, and updates to succeeded on happy path` | session row + session_events recorded, DB row updated |
| `prepends the agent's systemPrompt to the prompt passed to the CLI` | system prompt injection |
| `uses the per-call config overrides (model swap) — the fake echoes the chosen sessionID` | per-call config overrides |
| `materializes req.skills[].key into <cwd>/.opencode_cli/skills/<key>/SKILL.md before execute` | **new** — skills are written to disk before the adapter runs (sharedHome for opencode CLI) |
| `classifies the fake CLI's auth error as errorFamily='auth' (sessions-layer re-classifier)` | reclassifier on the success path |
| `classifies the fake CLI's rate-limit error as errorFamily='provider_quota' (sessions-layer re-classifier)` | reclassifier → quota |
| `classifies a timeout-shaped errorMessage as errorFamily='transient_upstream'` | reclassifier → timeout |
| `classifies unknown errors as errorFamily='internal' (no false positives)` | reclassifier doesn't lie |
| `classifies adapter THROWs on the catch path (regression for the original regex)` | catch path uses the same classifier |
| `classifies unknown errors from the fake CLI as errorFamily='internal'` | the reclassifier works on stderr-shaped errors |
| `triggers the catch-path classification when the adapter THROWS (e.g. spawn ENOENT)` | catch path doesn't fall through to undefined |
| `passes req.resume.sessionId into ctx.runtime.sessionId (the adapter decides whether to forward)` | resume flow |
| `prepends req.resume.context to the prompt as a '## Wakeup context' block` | wake-up delta prompt |
| `appends req.handoffMarkdown to the assistant summary on success` | handoff markdown appended to summary AND resultJson |
| `persists req.parentSessionId into the sessions.parent_session_id column` | parent linkage in DB |
| `marks the run failed with errorFamily='user_cancelled' when budget.perRun.tokens is exceeded` | budget enforcement |
| `does NOT mark a run failed when budget.perRun.tokens is generous (no violation)` | no false positives |
| `records usage (inputTokens / outputTokens / cost) into the session row's resultJson` | usage persistence |
| `serializes concurrent sessions.execute() calls via the cross-process lock` | 4 parallel calls all succeed |
| `captures stderr from the CLI in session_events of kind 'stderr'` | stderr captured into session_events |
| `records stderr-kind session_events when the CLI writes to stderr (the direct path is verified separately)` | persists errorMessage column from adapter (not errorCode) |
| `persists adapter's errorMessage (not the errorCode) into the session row's errorMessage column` | errorMessage column fallback chain |
| `Sessions.execute() with the real opencode CLI produces a real session row` | real CLI smoke (skipped if `opencode` not on PATH) |
| `agentAdapterConfig passes the agent model to the provider while preserving explicit adapter overrides` | unit: config shape |

### How to run

```sh
cd packages/sessions

# Full suite (~30 s; 18 s is the real-CLI smoke)
pnpm test

# Only e2e (~30 s)
pnpm test:e2e

# Typecheck
pnpm typecheck
```

Each e2e test gets its own SQLite file (cloned from a seed) via
`AASPAI_DB=sqlite:<path>`, so the tests are fully isolated and can run in
parallel without cross-test contamination.

---

## Real-CLI smoke (against the installed `opencode` binary)

The hermetic e2e suite above uses a fake CLI. The real-CLI smoke
test (in the harness package) actually invokes the installed
`opencode` binary, runs the full adapter+session+skills+tools+MCP
stack, and dumps every artifact to disk.

```sh
# From the repo root
yarn test:real

# Or directly
node node_modules/tsx/dist/cli.mjs packages/harness/__tests__/real-e2e/run-real.ts
```

Latest run (2026-07-25, 6 scenarios in 304 s):

| Scenario | sessionId | text | tool (native) | dispatcher | MCP | Resumed |
| -------- | --------- | ---- | ------------- | ---------- | --- | ------- |
| 01-happy | ses_06700caf2ffeoQmmpijCfC3wzo | 1 | 0 | 0 | 0 | — |
| 02-resume | ses_06700caf2ffeoQmmpijCfC3wzo (reused) | 1 | 0 | 0 | 0 | ✅ |
| 03-flags | ses_067002350ffehKK7lPsEZqW7oC | 1 | 0 | 0 | 0 | — |
| 04-mcp | ses_066ffe043ffetO1lSdtNVks5U1 | 1 | 0 | 0 | **2** | — |
| 05-tools | ses_066ff97dfffeU5EhQCTLzQCZAM | 1 | 0 | 0 | 0 | — |
| 06-thinking-stream | ses_066ff248dffeLv3zSFop0HEToC | 1 | **4** | 0 | 0 | — |

The full per-scenario dump layout, every captured event, and the
XDG/skills tree snapshots are in
`packages/.aaspai-e2e/scenarios/<name>/` — see the harness
`README.md` "Real-CLI E2E" section for the field-by-field
breakdown.
