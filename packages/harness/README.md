# `@aaspai/harness`

The adapter layer. Every agent execution in aaspai goes through a `ServerAdapterModule`
(`@aaspai/contracts/harness`) — a function-shaped object with `info`, `execute(ctx)`,
and `testEnvironment(ctx)`. This package ships the concrete adapters, plus the
shared utilities (process spawner, secret redaction, progress reporting, env
builder) the adapters compose.

## Adapter registry

`getAdapter(type)` returns the singleton `ServerAdapterModule` for a known
`AdapterType`. `listAdapters()` enumerates all of them with their capabilities.

| `AdapterType`         | Transport          | Status  | What it does                                                                                  |
| --------------------- | ------------------ | ------- | --------------------------------------------------------------------------------------------- |
| `claude_local`        | `local_subprocess` | ready   | Spawns `claude --output-format stream-json --verbose`, parses JSONL.                          |
| `codex_local`         | `local_subprocess` | ready   | Spawns `codex exec --json`, parses JSONL.                                                     |
| `opencode_cli`        | `local_subprocess` | ready   | Spawns `opencode run --format json`, parses JSONL. **Full control surface — see below.**       |
| `cursor_local`        | `local_subprocess` | stub    | Cursor CLI adapter — not implemented in this slice.                                           |
| `cursor_cloud`        | `cloud_sdk`        | stub    | Cursor cloud adapter — not implemented.                                                       |
| `openclaw_gateway`    | `gateway`          | stub    | OpenClaw WebSocket + Ed25519 device pairing.                                                  |
| `hermes_gateway`      | `gateway`          | stub    | Hermes HTTP/SSE gateway.                                                                     |
| `dry_run_local`       | `local_subprocess` | ready   | No-op deterministic adapter for end-to-end testing without API keys. Includes CEO role.       |

The `capabilitiesFor(info)` helper in `src/registry.ts` derives
`ProviderCapabilities` (execute, streaming, cancellation, timeout, …) from the
adapter's `info.status`. A non-`ready` adapter reports everything as `false`.

---

## `@aaspai/harness` package surface

### Public exports (`@aaspai/harness`)

```ts
import {
  // Adapter modules + metadata
  opencodeCli, opencodeCliInfo,
  claudeLocal, claudeLocalInfo, claudeLocalConfigSchema, DEFAULT_CLAUDE_LOCAL_CONFIG,
  codexLocal, codexLocalInfo, codexLocalConfigSchema, DEFAULT_CODEX_LOCAL_CONFIG,
  dryRunLocal, dryRunLocalInfo,
  cursorLocal, cursorLocalInfo,
  cursorCloud, cursorCloudInfo,
  openclawGateway, openclawGatewayInfo,
  hermesGateway, hermesGatewayInfo,

  // Registry + capabilities
  ADAPTER_REGISTRY_VERSION,
  getAdapter, getAdapterCapabilities, isAdapterReady, listAdapters,

  // Per-adapter helpers
  parseClaudeStreamLine, formatClaudeTranscriptEntry,
  parseCodexStreamLine, formatCodexTranscriptEntry,

  // Shared utilities
  buildAgentEnv,
  createRuntimeProgressReporter, RUNTIME_PROGRESS_PHASES,
  redactHomePath, redactHomePathInValue, redactCommandText, redactEnv,
  runProcess,
  SANDBOX_STUB_MESSAGE, SandboxTransportUnavailableError,
  SSH_STUB_MESSAGE, SshTransportUnavailableError, ensureSshTransportAvailable,
} from "@aaspai/harness";
```

### Subpath exports

| Subpath                                | What it re-exports                                       |
| -------------------------------------- | -------------------------------------------------------- |
| `@aaspai/harness/contract`             | `* from "@aaspai/contracts/harness"`                    |
| `@aaspai/harness/shared/run-process`   | `runProcess` (subprocess spawner)                       |
| `@aaspai/harness/shared/redact`        | `redactHomePath`, `redactCommandText`, `redactEnv`, …    |
| `@aaspai/harness/shared/progress`      | `createRuntimeProgressReporter`, `RUNTIME_PROGRESS_PHASES` |
| `@aaspai/harness/shared/env`           | `buildAgentEnv`                                         |
| `@aaspai/harness/shared/ssh`           | SSH transport stub                                       |
| `@aaspai/harness/shared/sandbox`       | `SandboxClient` type + transport stub                    |
| `@aaspai/harness/drivers/claude-local` | `claudeLocal` + config + parser/formatter                |
| `@aaspai/harness/drivers/codex-local`  | `codexLocal` + config + parser/formatter                 |
| `@aaspai/harness/drivers/opencode-cli`  | `opencodeCli` + argv dumper                              |
| `@aaspai/harness/registry`             | `getAdapter`, `listAdapters`, …                          |

### Scripts

| Script              | What it does                                                        |
| ------------------- | ------------------------------------------------------------------- |
| `pnpm test`         | Full vitest suite (~6 s) — unit tests + e2e                         |
| `pnpm test:e2e`     | Only the `describe("e2e: …")` blocks — the opencode-cli e2e suite    |
| `pnpm typecheck`    | `tsc --noEmit` against `src/` + `__tests__/`                         |
| `pnpm lint`         | biome check                                                          |
| `pnpm clean`        | Remove `dist/` and `.turbo/`                                         |

---

## `opencode_cli` adapter — full control surface

This is the adapter you reach for when you want to drive the opencode CLI
end-to-end with deterministic, testable behavior. Every CLI flag the adapter
sets, every env var it injects, and every config field you can override is
documented below.

### CLI args the adapter sends to `opencode run …`

The adapter calls:

```
opencode run --format json --model <model> --title <title> \
  [--session <id>] [--fork] \
  <prompt>
```

| Flag                | When set                                                   | Source                                            |
| ------------------- | ---------------------------------------------------------- | ------------------------------------------------- |
| `--format json`     | always                                                     | hard-coded (drives our JSONL parser)             |
| `--model`           | always                                                     | `config.model` (default `opencode-go/mimo-v2.5`)  |
| `--title`           | always                                                     | `config.title` (default `"aaspai-session"`)       |
| `--session <id>`    | when `ctx.runtime.sessionId` is set                          | the sessions layer's `req.resume.sessionId`       |
| `--fork`            | when `runtime.sessionParams.fork === true`                  | the sessions layer                                |
| `--print-logs`      | when `ctx.runtime.sessionParams.printLogs === true`         | operator config                                   |
| extra `...args`     | when present                                                | `config.commandArgs` (prepended to all args)      |

`<prompt>` is always passed as a positional argument (last argv). We do not
use stdin because Windows child_process pipe semantics are unreliable for
JSON-line streams.

### Config fields you can set on the agent

Every field is optional. The defaults are tuned for the opencode CLI's own
defaults; override only what you need.

| Field                              | Default               | Maps to                                              |
| ---------------------------------- | --------------------- | ---------------------------------------------------- |
| `command`                          | `"opencode"`          | binary path (or `process.execPath` for a Node script) |
| `commandArgs`                      | `[]`                  | prepended to the spawned argv                        |
| `model`                            | `"opencode-go/mimo-v2.5"` | `--model` flag                                     |
| `title`                            | `"aaspai-session"`    | `--title` flag                                      |
| `printLogs`                        | `false`               | `--print-logs` flag (opencode writes its own logs to stderr) |
| `cwd`                              | inherited from session | `--dir` (opencode only when invoked as a server; not currently forwarded) |
| `extraArgs`                        | `[]`                  | appended to the spawned argv (after `--title`)        |
| `env` (object)                     | `{}`                  | merged into the spawn env                            |

The operator model list (the `info.models` array) is a static set of
opencode-go/* model ids — extend it in `src/drivers/opencode-cli/index.ts`
when you want to expose more.

### Env vars the adapter reads

| Env var                    | Effect                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------- |
| `OPENCODE_CLI`             | Resolves the binary path. If set and the file exists, takes precedence over the ProgramFiles / PATH lookup. |
| `OPENCODE_CLI_DIR`         | If set, the adapter spawns the CLI in this directory instead of the session's `cwd`.       |
| `AASPAI_OPENCODE_LOCK_PATH` | Path for the cross-process advisory lock file. Override per-test; default `tmpdir/aaspai-opencode.lock`. |
| `AASPAI_RUN_MAX_BUFFER_BYTES` | Per-stream byte cap for `runProcess`. The opencode-cli adapter doesn't use this directly but the subprocess helpers do. |

### Env vars the adapter injects into the child

In addition to everything in the parent process env, every spawned opencode
child receives the `AASPAI_*` variables built by `buildAgentEnv(agent, …)`:

| Env var                | Value                                                          |
| ---------------------- | -------------------------------------------------------------- |
| `AASPAI_AGENT_ID`      | the agent's id                                                 |
| `AASPAI_ORGANIZATION_ID` | the org id                                                    |
| `AASPAI_AGENT_NAME`    | the agent's title                                              |
| `AASPAI_ADAPTER_TYPE`  | `"opencode_cli"`                                               |
| `AASPAI_RUN_ID`        | the aaspai session id (e.g. `sess_<uuid>`)                    |
| `AASPAI_SESSION_ID`    | only if `runtime.sessionId` is set                              |
| `AASPAI_SESSION_DISPLAY_ID` | only if `runtime.sessionDisplayId` is set                    |
| `AASPAI_CWD`           | only if `context.cwd` is set                                    |
| `AASPAI_PROTOCOL_VERSION` | always `"1"`                                                 |

### Concurrency model

The adapter uses two locks to serialize concurrent invocations:

1. **Per-process chain** (`cliChain` in `src/drivers/opencode-cli/index.ts`).
   Every `execute()` call awaits the previous one before spawning a new
   child. Peak concurrent children from a single Node process is 1.

2. **Cross-process advisory lock** (`AASPAI_OPENCODE_LOCK_PATH`). A
   file-based lock with PID-staleness stealing, 50ms × 200 retry
   (= 10s max wait). The file holds `<pid>@<hostname>@<nonce>` so a
   crashed holder can be detected and its lock stolen.

The opencode CLI uses a single SQLite database at
`~/.local/share/opencode/opencode.db` and concurrent invocations can race on
writes — this lock is the reason. paperclip has the same lock
(`acquireCommandManagedRuntimeClient`); we use a simpler file-based version
because the foundation slice doesn't need the full SSH / sandbox machinery.

### 5-minute hard timeout

The adapter hard-kills the child at `CLI_TIMEOUT_MS = 5 * 60 * 1000`:

1. `SIGTERM` to the child.
2. Wait 5 s.
3. If still alive, `SIGKILL`.
4. If still alive, resolve the promise with `timedOut: true`,
   `exitCode: null`, `signal: "SIGKILL"`, and a synthesized errorMessage.

A test-driven `AbortSignal` (`ctx.signal.aborted()`) takes the same path but
short-circuits to `signal: "SIGTERM"`, `errorCode: "killed_by_signal"`,
`errorFamily: "transient_upstream"`.

### Result shape

Every `opencodeCli.execute(ctx)` call returns an `AdapterExecutionResult`:

| Field            | Source                                                            |
| ---------------- | ----------------------------------------------------------------- |
| `sessionId`      | first `sessionID` seen in any JSON event; fallback `shortId("oc")`  |
| `sessionDisplayId` | first 12 chars of `sessionId`                                  |
| `sessionParams`  | `{ model, cli: "opencode", resume: <bool>, fork: <bool> }`         |
| `exitCode`       | the child's exit code OR `null` if killed by signal                |
| `signal`         | the killing signal OR `undefined` if exited normally               |
| `timedOut`       | `true` if the hard-timeout or signal path fired                     |
| `errorMessage`   | JSON error event message (paperclip-style) → stderr → kill-desc    |
| `errorCode`      | `"timeout"` / `"killed_by_signal"` / `"opencode_cli_failed"` / `undefined` |
| `errorFamily`    | `"transient_upstream"` for timeout/signal, `"internal"` for non-zero, or whatever the sessions layer reclassifies via `classifyErrorFamily()` |
| `usage`          | `{ inputTokens, outputTokens, cachedInputTokens }` from `step_finish` events (max-of-aggregated, falls back to `ceil(chars/4)` estimate) |
| `costUsd`        | max of all `step_finish.cost` values                              |
| `summary`        | first 500 chars of concatenated `text` events                       |
| `provider`       | `"opencode"`                                                       |
| `biller`         | `"opencode-cli"`                                                   |
| `model`          | the model the user selected (or `undefined`)                       |
| `billingType`    | `"api"`                                                            |
| `clearSession`   | `false` (the opencode CLI manages its own session DB)              |

---

## Comparison: aaspai vs paperclip vs the opencode CLI itself

> **Note on paperclip references.** Paperclip is referenced throughout this
> README purely for **study and comparison** — it is a separate project
> (not a dependency, not a competitor, not a target we're trying to
> match one-for-one). The comparison tables below are the honest
> accounting: aaspai covers a smaller surface than paperclip, and that's
> intentional. We use paperclip as a "what does a more elaborate adapter
> look like" reference and a way to cross-check our design. Source:
> `study/paperclip/` in this repo. The `AGENTS.md` there is authoritative
> for that project; the `aaspai/AGENTS.md` is authoritative for this one.

The aaspai adapter is the smallest faithful subset of paperclip's
paperclip reference adapter, with a few opinionated changes. This table is the
honest comparison — every column reflects what is actually in the code today.

### CLI args

| CLI flag                  | aaspai `opencode_cli` | paperclip reference (`execute.ts:574-583`) |
| ------------------------- | :-------------------: | :-----------------------------------------------: |
| `--format json`           | ✅                    | ✅                                                |
| `--model <id>`            | ✅                    | ✅                                                |
| `--title <title>`         | ✅                    | ✅                                                |
| `--print-logs`            | ✅ (via `printLogs` config) | ✅ (via `PAPERCLIP_OPENCODE_PRINT_LOGS` env) |
| `--session <id>`          | ✅ (NEW)              | ✅                                                |
| `--fork`                  | ✅ (NEW)              | ✅                                                |
| `--continue` (`-c`)       | ❌ (use `--session`)  | ❌ (same)                                         |
| `--variant <v>`           | ❌ (not in model list) | ✅                                                |
| `--agent <a>`             | ❌                    | ❌ (set via OpenCode's own `opencode agent` config) |
| `--dir <path>`            | ❌ (use OPENCODE_CLI_DIR env) | ❌                                         |
| stdin prompt              | ❌ (positional arg)   | ❌                                                |
| interactive (`-i`)        | ❌ (foundation slice runs headless) | ❌                              |

### Config (operator-visible) fields

| Field                          | aaspai   | paperclip                                                                       |
| ------------------------------ | :------: | :------------------------------------------------------------------------------ |
| `command`                      | ✅       | ✅                                                                              |
| `commandArgs`                  | ✅       | ❌ (uses `extraArgs` instead)                                                   |
| `extraArgs`                    | ❌       | ✅                                                                              |
| `model`                        | ✅       | ✅                                                                              |
| `title`                        | ✅       | ❌                                                                              |
| `variant`                      | ❌       | ✅                                                                              |
| `dangerouslySkipPermissions`   | ❌       | ✅ (injects `permission.external_directory=allow` in `opencode.json`)           |
| `promptTemplate`               | ❌       | ✅ (`renderTemplate(bootstrapPromptTemplate, …)`)                                |
| `bootstrapPromptTemplate`      | ❌       | ✅                                                                              |
| `instructionsFilePath`         | ❌       | ✅ (prepends file contents to the prompt)                                        |
| `cwd`                          | ✅       | ❌ (read from `paperclipWorkspace.cwd`)                                         |
| `env` (object)                 | ✅       | ❌                                                                              |
| `printLogs`                    | ✅       | ❌ (uses env var)                                                               |
| `helloProbeTimeoutSec`         | ❌       | ✅ (in `testEnvironment`)                                                       |
| `modelProvider` / `modelId`    | n/a      | ✅ (set via `prepareOpenCodeRuntimeConfig` → `opencode.json`)                  |

### Env-var controls

| Env var                            | aaspai   | paperclip (from `runtime-config.ts`/`execute.ts`)               |
| ---------------------------------- | :------: | :-------------------------------------------------------------- |
| `OPENCODE_CLI`                     | ✅       | ✅ (`PAPERCLIP_OPENCODE_COMMAND`)                                |
| `OPENCODE_CLI_DIR`                 | ✅       | ❌                                                            |
| `AASPAI_OPENCODE_LOCK_PATH`         | ✅       | n/a (paperclip uses SSH/sandbox-managed locks)                 |
| `OPENCODE_DISABLE_PROJECT_CONFIG`  | ❌       | ✅ (always set; prevents `opencode.json` pollution)            |
| `OPENCODE_ALLOW_ALL_MODELS`        | ❌       | ✅ (skips the `opencode models` availability probe)             |
| `PAPERCLIP_OPENCODE_PRINT_LOGS`     | ❌       | ✅ (alternative way to enable `--print-logs`)                  |
| `PAPERCLIP_OPENCODE_CHEAP_MODEL`   | ❌       | ✅ (cheap-budget-lane model override)                          |
| `AASPAI_RUN_MAX_BUFFER_BYTES`       | ✅ (via `runProcess` shared util) | ❌                                |

### What gets injected into the child

| Injection                | aaspai                                                       | paperclip (from `execute.ts:253-289` + `runtime-config.ts`)                  |
| ------------------------ | :----------------------------------------------------------: | :---------------------------------------------------------------------------: |
| `AASPAI_AGENT_ID` … etc. | ✅ (`buildAgentEnv`)                                          | ❌ (uses `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, …)                       |
| `XDG_CONFIG_HOME`        | ❌ (opencode uses its default)                                | ✅ (pointed at a runtime-prepared `opencode.json`)                              |
| `HOME`                   | ❌                                                           | ✅ (pointed at runtime root for managed runtimes)                                |
| Custom `opencode.json`   | ❌ (no `dangerouslySkipPermissions` shortcut)                 | ✅ (writes a temp `opencode.json` with `permission.external_directory=allow`)   |
| `OPENCODE_DISABLE_PROJECT_CONFIG=true` | ❌                                              | ✅ (always)                                                                    |

### What the adapter extracts from the stream

| Stream event kind        | aaspai                                                                          | paperclip (`parse.ts`)                                |
| ------------------------ | :------------------------------------------------------------------------------: | :---------------------------------------------------: |
| `step_start`             | emulated as `onLog("stdout", { kind: "init", event: "step_start" })`            | nothing (pure passthrough)                            |
| `text` (part.text)       | extracted to `summary`; forwarded as `onLog({ kind: "assistant" })`              | extracted to `summary`; **silently dropped from onLog** |
| `step_finish` (tokens)   | max-of-aggregated `inputTokens`/`outputTokens`/`cost`; emitted as `onLog({ kind: "result" })` | same; emitted as `onLog` only if `result.event` is `step_finish` |
| `error` (`event.error`)  | **NEW** — extracted via `extractErrorMessage()`; put in `errorMessage`           | same; also put in `errorMessage`                       |
| `tool_use`               | emitted as `onLog({ kind: "init", event: "tool_use" })`                         | tool errors extracted separately, not surfaced as kind=init |
| stderr text              | appended to `stderrBuf` → fallback for `errorMessage`                            | same                                                  |

### Error handling

| Failure mode                       | aaspai `opencode_cli`                                      | paperclip reference                                         |
| ---------------------------------- | :--------------------------------------------------------: | :----------------------------------------------------------: |
| `errorCode` taxonomy                | `timeout` / `killed_by_signal` / `opencode_cli_failed`      | `timeout` / `unknown_session` (forces a retry)               |
| `errorFamily` taxonomy              | `transient_upstream` (timeout, signal) / `internal` (else) | `transient_upstream` (timeout) / `internal` (default)         |
| `signal` surfaced in result         | ✅ (NEW — was dropped before)                              | ❌                                                         |
| `exitCode` on signal-killed child   | `null` (NEW — was coerced to 0)                             | `null`                                                      |
| `--session` resume round-trip      | ✅ (NEW — was ignored)                                     | ✅ (but with auto-retry on unknown-session)                   |
| `errorMessage` from JSON event     | ✅ (NEW — paperclip parity)                                 | ✅                                                          |

### Concurrency

| Mechanism                  | aaspai                                                          | paperclip                                              |
| -------------------------- | :-----------------------------------------------------------: | :----------------------------------------------------: |
| Per-process chain          | `cliChain.then(fn, fn)`                                        | `acquireCommandManagedRuntimeClient` + sandbox queue  |
| Cross-process lock         | file-based `AASPAI_OPENCODE_LOCK_PATH` (PID-staleness stealing) | SSH/sandbox lease + 10-min lease timeout              |
| Hard timeout               | 5 min wall, SIGTERM → SIGKILL → resolve with `timedOut: true` | configurable per-call (`timeoutSec`)                  |

### Lifecycle hooks

| Hook                         | aaspai                                   | paperclip                                       |
| ---------------------------- | :--------------------------------------: | :----------------------------------------------: |
| `testEnvironment(ctx)`       | runs `opencode --version` and reports a single check | probes with `discoverOpenCodeModels` + hello run |
| `prepareRuntimeConfig`       | ❌                                       | ✅ (writes a temp `opencode.json` if `config` has runtime overrides) |
| `materials prep`             | ❌                                       | ✅ (skills, opencode.json)                       |
| `restoreWorkspace`           | ❌ (in-process lock is enough)            | ✅ (sandbox round-trip)                          |
| Session continuity            | `--session` + `--fork`                  | `--session` + auto-retry on `unknown_session`    |

---

## Skills, Tools, and MCP — the orchestration control surface

The aaspai adapter controls three orthogonal orchestration surfaces
that a paperclip-style harness needs: **skills** (file-based
instruction packages), **tools** (callable functions the agent can
invoke), and **MCP servers** (external Model Context Protocol
endpoints). The control is layered:

| Layer | Where it lives | What it controls |
| --- | --- | --- |
| **Skills (catalog)** | `@aaspai/skills` package | builds a `SkillCatalog` from a `catalog/{bundled,optional}/<category>/<slug>/` tree, registers every skill into a `SkillRegistry` |
| **Skills (materialize)** | `Sessions.execute()` | writes SKILL.md + every file to `<cwd>/.opencode_cli/skills/<key>/` (or symlinks into `~/.claude/skills` for the opencode CLI default) |
| **Tools (dispatch)** | `AdapterExecutionContext.tools` | every `tool_use` event from the CLI is routed to `tools.invoke(name, input)`; the result is recorded as a `tool_result` event |
| **MCP (per-call)** | `Config.mcpServers` | the opencode CLI's `~/.config/opencode/mcp.json` is generated per-run from the config; the CLI handles transport + tool calls natively |

### Skills — `SkillCatalog` + `SkillRegistry`

```ts
import { SkillCatalog, SkillRegistry, writeSkillFile } from "@aaspai/skills";

// 1. Build a catalog from a `catalog/` tree
const { catalog, manifest, errors } = await SkillCatalog.load("/path/to/skills-root");
const { registered, skipped } = await catalog.registerAllInto(myRegistry);

// 2. Materialize the resolved skills to disk before execute
await myRegistry.materialize(resolvedSkills, {
  adapterType: "opencode_cli",
  runtimeBaseDir: cwd,
  sharedHome: true,    // write to ~/.claude/skills (the opencode CLI default)
  symlink: true,       // symlink target → cache (aaspai stays the source of truth)
  verifySha256: true,  // SHA-256 check on every file (paperclip parity)
});
```

`Skill.files[].kind` is one of `skill | markdown | reference | script | asset | other` (auto-classified from path) — same vocabulary as `@paperclipai/skills-catalog`. `Skill.files[].sha256` is auto-computed if not set in frontmatter.

GitHub-pinned skills are supported via `catalog-ref.json`:

```json
{
  "source": {
    "type": "github",
    "owner": "mvanhorn",
    "repo": "last30days-skill",
    "ref": "v3.3.0",
    "commit": "daca71f89eb71d0d56d01a43ed7627aa919dba4f",
    "path": "skills/last30days"
  },
  "files": ["SKILL.md", "scripts/briefing.py"]
}
```

### Tools — `ctx.tools` dispatcher (adapter-defined tools)

```ts
const ctx: AdapterExecutionContext = {
  // ...
  tools: {
    invoke: async (name, input, ctx) => {
      // route the call to your own implementation
      return await myDispatcher.call(name, input, ctx);
    },
    list: () => ["paperclip_summarize", "paperclip_handoff"],
  },
};
```

Every `tool_use` event the opencode CLI emits is routed to
`tools.invoke(name, input)`. The result is recorded as a
`tool_result` session event and surfaces in `resultJson.toolsInvoked`.
The opencode CLI still owns the tool-orchestration loop — we just
record what the dispatcher decided.

**Architectural note (clarifies when this fires).** The opencode CLI
has a built-in tool set — `bash`, `edit`, `read`, `write`, `glob`,
`grep`, `webfetch`, `todowrite`, `task`, `skill`. Those are wired
internally by the CLI and **do not** flow through `ctx.tools.invoke`;
they show up as native `tool_result` events that the harness
parser decodes directly into `resultJson.toolEvents` (see
`parseEvent` at `src/drivers/opencode-cli/index.ts:694`). The
dispatcher is for **adapter-defined** tools — i.e. tools aaspai
injects that the opencode CLI does not already provide. To prove
this: scenario `06-thinking-stream` of the real-CLI suite
(`__tests__/real-e2e/run-real.ts`) records `toolEvents=4` and
`dispatcherCalls=0` — the model called the CLI's native `skill`
+ 3× `bash` tools, not aaspai-defined ones. The dispatcher is
exercised end-to-end by the fake-CLI test
`routes every tool_use through ctx.tools.invoke and records the result`.

Pinned by: `routes every tool_use through ctx.tools.invoke and records the result`, `records a failed tool_result when the dispatcher throws`, `does not call the dispatcher when ctx.tools is not provided`.

### MCP — `Config.mcpServers` (client-side MCP)

```ts
const config: AdapterExecutionContext = {
  // ...
  config: {
    mcpServers: {
      context7: { type: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp"] },
      fetch: { type: "http", url: "https://mcp.example.com" },
    },
  },
};
```

The adapter writes a `mcp.json` into the per-call `XDG_CONFIG_HOME`
temp dir (or the caller's `xdgConfigHome` if provided) so the
opencode CLI discovers and connects to the servers natively. We do
**not** implement an in-process MCP client — the opencode CLI
already speaks the JSON-RPC framing for both stdio and http
transports.

Pinned by: `config.mcpServers writes <xdg>/opencode/mcp.json`,
`omits mcp.json when no servers are configured`.

### Paperclip parity scorecard (updated)

| Surface | Paperclip | aaspai (after this pass) |
| --- | :---: | :---: |
| Skill data model | `CatalogSkill` (12 fields) | `Skill` (13 fields including `kind`, `sha256`) |
| Skill registry | 355-line service | 122-line `SkillRegistry` + 555-line `SkillCatalog` |
| Skill catalog (JSON manifest) | 1013 lines + `generated/catalog.json` | `SkillCatalog` with same shape + GitHub pinning |
| GitHub-pinned skills | ✅ | ✅ |
| Skill sha256 + contentHash | ✅ | ✅ |
| Skill materialize (per-adapter dir) | ✅ | ✅ (added sharedHome + symlink + verifySha256) |
| Skill inline-into-prompt | n/a | ✅ (kept as fallback) |
| Tool registry → adapter dispatch | ✅ | ✅ (via `ctx.tools.invoke`) |
| Built-in tool set | 12+ JSON schemas | 12 stubs (the 12+ tool definitions) |
| Tool execution path | ✅ adapter routes to resolvers | ✅ adapter routes to `ctx.tools.invoke` |
| MCP server (consumed by external hosts) | ✅ `@paperclipai/mcp-server` | n/a (we want a client, not a server) |
| MCP client (connect to external servers) | n/a | partial (we let the opencode CLI do it via `mcp.json`) |
| `~/.config/opencode/mcp.json` write | ✅ via server | ✅ via `Config.mcpServers` + temp XDG_CONFIG_HOME |
| `dangerouslySkipPermissions` | ✅ | ✅ |
| Test environment (hello + models) | ✅ | ✅ |

---

## E2E test surface

The e2e suite (`__tests__/e2e.test.ts`, plus the `__tests__/e2e/` directory)
gives you 100% control over the CLI by pointing the adapter at a fake
Node-script CLI (`__tests__/fixtures/fake-opencode.cjs`). The fake's behavior
is driven by markers in the prompt and a handful of env vars.

### Fake CLI behavior markers (read from the prompt)

| Marker                          | Effect                                                    |
| ------------------------------- | --------------------------------------------------------- |
| `<e2e:success>` (default)        | emits step_start → text → step_finish and exits 0         |
| `<e2e:success:multi>`            | emits 3 text events                                       |
| `<e2e:success:long:N>`           | emits one text event of N chars                           |
| `<e2e:response:XYZ>`             | override the text payload (default `"PONG from fake opencode"`) |
| `<e2e:session:ses_xyz>`          | override the emitted sessionID                            |
| `<e2e:no_session>`               | omit sessionID from all events                            |
| `<e2e:tokens:I,O,C,R,cost>`      | override the step_finish counters                         |
| `<e2e:tool>`                     | emit a tool_use event                                     |
| `<e2e:error:auth>`               | emits a JSON error event with message `"api key invalid: …"`, exit 1 |
| `<e2e:error:quota>`              | emits a JSON error event with message `"rate limit exceeded; …"`, exit 1 |
| `<e2e:error:refusal>`            | emits a JSON error event with message `"content policy refusal"`, exit 1 |
| `<e2e:error:generic>`            | emits a generic error message, exit 1                     |
| `<e2e:error:stderr>`             | writes to stderr only, exit 1                             |
| `<e2e:hang>`                     | never exits (timeout/abort test)                          |
| `<e2e:exit:N>` / `<e2e:delay:N>` | exit code / pre-event delay                               |

### Fake CLI env hooks

| Env var                            | Effect                                                  |
| ---------------------------------- | ------------------------------------------------------- |
| `AASPAI_FAKE_OPENCODE_STDERR`       | prefix injected into stderr before the run starts        |
| `AASPAI_FAKE_OPENCODE_STDOUT`       | prefix injected into stdout before the run starts        |
| `AASPAI_FAKE_OPENCODE_DUMP_ARGV`   | write the full argv to this file path                    |
| `AASPAI_FAKE_OPENCODE_PROMPT_OVERRIDE` | replace the prompt parser output with this string    |
| `AASPAI_FAKE_OPENCODE_PROBE_FILE`  | write every `OPENCODE_*` + `XDG_CONFIG_HOME` env var to this file (debug) |

---

## Real-CLI E2E (against the installed `opencode` binary)

The fake-CLI e2e suite is hermetic and fast, but it doesn't prove the
adapter works against a real CLI. The file
`__tests__/real-e2e/run-real.ts` runs the **real installed `opencode`**
binary through the full adapter+session+skills+tools+MCP stack and
dumps every artifact to disk for inspection.

### How to run

```sh
# From anywhere in the repo
node node_modules/tsx/dist/cli.mjs packages/harness/__tests__/real-e2e/run-real.ts
```

The script detects the CLI via `resolveOpencodeBinary()` (env
`OPENCODE_CLI` > ProgramFiles > PATH) and exits non-zero if the
binary is missing or not v1.x. It then runs the 6 scenarios below
sequentially against a temporary catalog + DB + XDG config home.

### Scenarios

| # | Scenario | What it proves |
| - | -------- | -------------- |
| 01 | `01-happy` | trivial prompt → text + tokens, no flags, no skills, no MCP |
| 02 | `02-resume` | second run reuses `sessionId` from 01 → model remembers prior context |
| 03 | `03-flags` | `--variant=max --agent=build --thinking` all surface in `resultJson.sessionParams` |
| 04 | `04-mcp` | `Config.mcpServers` writes `<xdg>/opencode/mcp.json` with stdio + http servers |
| 05 | `05-tools` | prompts the model to call `echo`/`now`/`noop` (adapter-defined tools); confirms the dispatcher surface exists even when CLI does not route those names |
| 06 | `06-thinking-stream` | full skill materialize → model reads the materialized `SKILL.md` from `~/.claude/skills/`, follows the verify-change workflow (git status → cat package.json → yarn test) — 4 native tool_result events decoded into `resultJson.toolEvents` |

### Dump layout

Every run writes a per-scenario subfolder to `packages/.aaspai-e2e/scenarios/<name>/`:

| File | Contents |
| ---- | -------- |
| `00-input.jsonl` | the exact `SessionRequest` sent to `Sessions.execute()` |
| `01-result.json` | the full `AdapterResult` (status, sessionId, durationMs, sessionParams, toolEvents, textEvents, …) |
| `02-session-row.json` | the row in the `sessions` table (after `Sessions.execute` finishes) |
| `03-resultJson.json` | just the `resultJson` sub-object — the `Schema.ResultJson` parse |
| `04-sessionParams.json` | just the `sessionParams` sub-object |
| `05-session_events.jsonl` | every event written to the `session_events` table (kind, seq, ts, payload) |
| `06-text-events.jsonl` | every `assistant` text event |
| `07-thinking-events.jsonl` | every `reasoning` event (only when `thinking: true`) |
| `08-tool-events.jsonl` | every `tool_result` event captured by the adapter |
| `09-tool-dispatcher-calls.jsonl` | every `ctx.tools.invoke()` call (currently 0 in the real-CLI run — the model used CLI-native tools instead) |
| `10-stderr.txt` | everything the opencode CLI wrote to stderr (init, LSP discovery, watcher backend, etc.) |
| `11-xdg-contents.txt` | tree of files in the per-call `XDG_CONFIG_HOME` (when set) — proves `mcp.json` / `config.json` were written |
| `12-shared-claude-skills.txt` | tree of files in `~/.claude/skills/` after `SkillRegistry.materialize({ sharedHome: true })` ran |

A top-level `SUMMARY.json` aggregates per-scenario stats, and a
`skills-catalog/` directory holds the 3 skill entries the
`SkillCatalog` discovered (bundled/ops/summarize, bundled/ops/verify-change,
optional/ops/remember).

### Latest run (2026-07-25)

```
total:        6
succeeded:    6
failed:       0
totalDurationMs: 304,602
```

| Scenario | Duration | sessionId | text | think | tool (native) | dispatcher | MCP | Notes |
| -------- | -------- | --------- | ---- | ----- | ------------- | ---------- | --- | ----- |
| 01-happy | 18.6 s | ses_06700caf2ffeoQmmpijCfC3wzo | 1 | 0 | 0 | 0 | 0 | `summary: "PONG"` |
| 02-resume | 24.2 s | ses_06700caf2ffeoQmmpijCfC3wzo (reused) | 1 | 0 | 0 | 0 | 0 | `summary: "PONG-AGAIN"` — model remembered prior |
| 03-flags | 16.5 s | ses_067002350ffehKK7lPsEZqW7oC | 1 | 0 | 0 | 0 | 0 | `summary: "PONG-FLAGS"`, sessionParams has variant/agent/thinking |
| 04-mcp | 18.5 s | ses_066ffe043ffetO1lSdtNVks5U1 | 1 | 0 | 0 | 0 | **2** | `mcp.json` written with filesystem (stdio) + notion (http) |
| 05-tools | 29.6 s | ses_066ff97dfffeU5EhQCTLzQCZAM | 1 | 0 | 0 | 0 | 0 | model replied `"I don't have echo, now, or noop tools available. I have bash, edit, …"` — proves adapter-defined tools are NOT in the CLI's native set |
| 06-thinking-stream | 197.3 s | ses_066ff248dffeLv3zSFop0HEToC | 1 | 0 | **4** | 0 | 0 | model read `~/.claude/skills/verify-change/SKILL.md`, ran `git status` → `cat package.json` → `yarn test`, returned the verify-change summary + `PONG-VERIFY` |

### What the real-CLI run validated

1. **`SkillRegistry.materialize({ sharedHome: true })`** writes SKILL.md to
   `C:\Users\sande\.claude\skills\verify-change\` and the opencode CLI
   discovers it on the next `run` (confirmed by the `skill` tool_result
   event payload in `06-thinking-stream/05-session_events.jsonl:36`).
2. **`runOpencodeCli`** correctly decodes the CLI's native `tool_result`
   events into `resultJson.toolEvents` (4 events: 1× `skill` + 3× `bash`).
3. **`Config.mcpServers`** writes `<xdg>/opencode/mcp.json` with the
   `{ mcpServers: { … } }` shape the CLI expects (confirmed at
   `scratch/xdg-scenario4/opencode/mcp.json`).
4. **Session resume** reuses the same `ses_06700caf2ffeoQmmpijCfC3wzo`
   session ID across runs 01+02.
5. **Session events table** correctly persists `step_start` /
   `reasoning` / `tool_result` / `result` / `assistant` / `stderr`
   kinds with `seq` ordering and a per-step token counter
   (8457 → 8729 → 9054 → 9119 → 14085 tokens; $0.0010490872 cost/step).

---

## Control surface — every `opencode_cli` flag, Config field, env var, and orchestration control

This is the **complete** surface the aaspai adapter exposes today. Every
item links to the source line that implements it and the test that
pins it. The earlier "Gaps" section is now fully closed — see the
test inventory at the bottom of this README for the proof.

### `opencode run` flags the adapter passes

`runOpencodeCli()` (`harness/src/drivers/opencode-cli/index.ts`) builds:

```
opencode run
  --format json
  --model <model>
  --title <title>
  [--variant <v>] [--agent <a>] [--thinking] [--pure] [--auto]
  [--share] [--log-level <level>] [--print-logs]
  [--dir <path>] [--attach <url>]
  [-c] (when continueLast)
  [--session <id>] [--fork] (when runtime.sessionId is set)
  [--file <path>] ... (one per config.attachments)
  <prompt>
```

| Flag | Source | Config field | Test pinning it |
| ---- | ------ | ------------ | --------------- |
| `--format json` | `runOpencodeCli` | (hard-coded) | `executes the happy path` |
| `--model <m>` | `runOpencodeCli` | `model` | `forwards config.model` etc. |
| `--title <t>` | `runOpencodeCli` | `title` | (default) |
| `--variant <v>` | `runOpencodeCli` | `variant` | `forwards config.variant` |
| `--agent <a>` | `runOpencodeCli` | `agent` | `forwards config.agent` |
| `--thinking` | `runOpencodeCli` | `thinking` | `forwards config.thinking=true` |
| `-c` | `runOpencodeCli` | `continueLast` | `forwards config.continueLast=true` |
| `--share` | `runOpencodeCli` | `shareSession` | `forwards config.shareSession=true` |
| `--pure` | `runOpencodeCli` | `pure` | `forwards config.pure=true` |
| `--auto` | `runOpencodeCli` | `autoApprove` | `forwards config.autoApprove=true` |
| `--log-level <level>` | `runOpencodeCli` | `logLevel` | `forwards config.logLevel` |
| `--print-logs` | `runOpencodeCli` | `printLogs` | `forwards config.printLogs=true` |
| `--dir <path>` | `runOpencodeCli` | `workingDir` | `forwards config.workingDir` |
| `--attach <url>` | `runOpencodeCli` | `attachServer` | `forwards config.attachServer` |
| `--session <id>` | `runOpencodeCli` | `ctx.runtime.sessionId` | `forwards runtime.sessionId` |
| `--fork` | `runOpencodeCli` | `ctx.runtime.sessionParams.fork` | `forwards runtime.sessionParams.fork` |
| `--file <path>` | `runOpencodeCli` | `attachments[]` | `forwards each entry of config.attachments` |

> `--command`, `--port`, `--username`, `--password` are intentionally
> not exposed via Config — they're server-side concerns used by
> `startOpencodeServe()` and `attachServer`, not per-call flags.
> `-i, --interactive` is **not** a gap — the adapter is
> headless-only; an interactive TTY would break the JSON event parser.

### Env vars the adapter injects into the child

| Env var | When | Source |
| ------- | ---- | ------ |
| `XDG_CONFIG_HOME=<xdgConfigHome>` | `xdgConfigHome` set | `prepareConfigInjection` |
| `OPENCODE_DISABLE_PROJECT_CONFIG=1` | `disableProjectConfig: true` | same |
| `OPENCODE_ALLOW_ALL_MODELS=1` | `allowAllModels: true` | same |
| `OPENCODE_SERVER_PASSWORD=<pw>` | `serverPassword` set | same |
| `OPENCODE_SERVER_USERNAME=<user>` | `serverUsername` set | same |

Pinned by: `sets XDG_CONFIG_HOME and writes config.json`,
`sets OPENCODE_DISABLE_PROJECT_CONFIG=1`, `dangerouslySkipPermissions writes {"*":"allow"}`.

### Env vars the adapter reads

| Env var | Effect | Source |
| ------- | ------ | ------ |
| `OPENCODE_CLI` | binary path override (wins over ProgramFiles) | `resolveOpencodeBinary` |
| `OPENCODE_CLI_DIR` | default cwd for the spawned child | `runOpencodeCli` |
| `AASPAI_OPENCODE_LOCK_PATH` | cross-process lock file | `acquireLock` |

### Configuration injection: opencode.json

When `xdgConfigHome` is set, the adapter writes
`<xdgConfigHome>/opencode/config.json` with the merged
`opencodeJson + permissions + providers + dangerouslySkipPermissions`
document and sets `XDG_CONFIG_HOME` so the opencode CLI reads it.

```ts
{
  xdgConfigHome: "/tmp/my-xdg",
  opencodeJson: { provider: { custom: { id: "x" } } },
  permissions: { bash: "allow" },
  providers: { anthropic: { apiKey: "sk-..." } },
  dangerouslySkipPermissions: true, // → permission: {"*":"allow"}
}
```

Pinned by: `sets XDG_CONFIG_HOME and writes config.json`,
`dangerouslySkipPermissions writes {"*":"allow"}`.

### Streaming: `onRuntimeProgress`

The adapter calls `ctx.onRuntimeProgress(update)` for every event type:

| Update shape | When |
| ------------ | ---- |
| `{ kind: "text_delta", sessionId, text, ts }` | every `text` event |
| `{ kind: "thinking_delta", sessionId, text, ts }` | every `thinking` event |
| `{ kind: "tool_event", sessionId, name, id, status, ts }` | every `tool_use` event |

Pinned by: `forwards each text event`, `forwards thinking events`,
`forwards tool_use events`.

### Persistent runtime

```ts
import { startOpencodeServe, stopOpencodeServe } from "@aaspai/harness/drivers/opencode-cli";

const server = await startOpencodeServe({ workspaceKey: "org1/repo-a" });
// → { url: "http://localhost:4096", port: 4096, pid: 1234 }
// Subsequent `execute({ config: { attachServer: server.url } })` calls
// pass --attach to the opencode CLI and reuse the running server.
stopOpencodeServe("org1/repo-a");
```

Pinned by: source compile + the `--attach` flag tests above.

### Hello probe + models list

```ts
import {
  runOpencodeHelloProbe,
  listOpencodeModels,
} from "@aaspai/harness/drivers/opencode-cli";

const probe = await runOpencodeHelloProbe({}); // { ok, reply, durationMs, error? }
const models = await listOpencodeModels({});   // ["opencode-go/mimo-v2.5", ...]
```

The `testEnvironment()` method now runs three checks: `--version`,
`opencode models`, and a hello probe. Each surfaces as a separate
`adapterEnvironmentCheck` row with `level: "info" | "warn" | "error"`.

Pinned by: `listOpencodeModels returns the model list`,
`runOpencodeHelloProbe returns ok=true`,
`testEnvironment reports a pass for the fake CLI and surfaces the resolved path`.

### Adapter shape (the full `Config` surface)

| Field | Type | Default | Effect |
| ----- | ---- | ------- | ------ |
| `model` | string | `opencode-go/mimo-v2.5` | `--model` |
| `title` | string | `OpenCode Session` | `--title` |
| `command` | string | (system lookup) | binary override |
| `commandArgs` | string[] | `[]` | extra args prepended to argv |
| `variant` | string | - | `--variant` |
| `agent` | string | - | `--agent` |
| `thinking` | boolean | `false` | `--thinking` |
| `continueLast` | boolean | `false` | `-c` |
| `shareSession` | boolean | `false` | `--share` |
| `pure` | boolean | `false` | `--pure` |
| `autoApprove` | boolean | `false` | `--auto` |
| `logLevel` | string | - | `--log-level` |
| `printLogs` | boolean | `false` | `--print-logs` |
| `workingDir` | string | - | `--dir` |
| `attachments` | string[] | `[]` | one `--file` per item |
| `attachServer` | string (URL) | - | `--attach` + reuse running server |
| `serverPassword` | string | - | `OPENCODE_SERVER_PASSWORD` |
| `serverUsername` | string | - | `OPENCODE_SERVER_USERNAME` |
| `xdgConfigHome` | string (path) | - | `XDG_CONFIG_HOME` + opencode.json |
| `opencodeJson` | object | `{}` | merged into opencode.json |
| `disableProjectConfig` | boolean | `false` | `OPENCODE_DISABLE_PROJECT_CONFIG=1` |
| `allowAllModels` | boolean | `false` | `OPENCODE_ALLOW_ALL_MODELS=1` |
| `permissions` | object | `{}` | merged into `permission` block |
| `providers` | object | `{}` | merged into `provider` block |
| `dangerouslySkipPermissions` | boolean | `false` | `permission: {"*":"allow"}` |

Pinned by the test classes at the bottom of this README.

### `AdapterExecutionResult` extras (Priority 8)

| Field | When | Test |
| ----- | ---- | ---- |
| `resultJson.cliSessionId` | opencode CLI emitted a `sessionID` | `resultJson surfaces cliSessionId` |
| `resultJson.continuedLast` | `continueLast: true` was set | (same) |
| `resultJson.attached` | `attachServer` was set | (same) |
| `resultJson.thinkingEventCount` | parser saw a `thinking` event | (same) |
| `resultJson.toolEventCount` | parser saw a `tool_use` event | (same) |
| `sessionParams.continueLast` | `continueLast: true` was set | `surfaces the full new sessionParams shape` |
| `sessionParams.variant` | `variant` was set | (same) |
| `sessionParams.agent` | `agent` was set | (same) |
| `sessionParams.thinking` | `thinking: true` was set | (same) |
| `sessionParams.attached` | `attachServer` was set | (same) |

### `sessions`-layer orchestration (Priority 7 + 8)

| `SessionRequest` field | Effect | Test |
| ---------------------- | ------ | ---- |
| `resume.context` | prepended to the prompt as `## Wakeup context\n\n...` on resume | `prepends req.resume.context` |
| `handoffMarkdown` | appended to the assistant summary on success | `appends req.handoffMarkdown` |
| `parentSessionId` | persisted into `sessions.parent_session_id` | `persists req.parentSessionId` |
| `budget.perRun.tokens` | if exceeded, status → `failed`, `errorFamily → "user_cancelled"`, `errorCode → "budget_exceeded:tokens"` | `marks the run failed when budget.perRun.tokens is exceeded` |
| `budget.perRun.costUsd` | same pattern | (covered by helper) |
| `budget.perRun.durationMs` | same pattern | (covered by helper) |
| (no budget) | status stays `succeeded`, `errorFamily` undefined | `does NOT mark a run failed when budget.perRun.tokens is generous` |

### What we still don't do (the honest remainder)

The aaspai adapter is intentionally smaller than paperclip. The
remaining "gaps" are things we explicitly chose not to add because
they don't match aaspai's headless-orchestrator shape:

| Gap | Why we don't do it |
| --- | ------------------ |
| `opencode web`, `opencode upgrade`, `opencode github`, `opencode pr` | product features, not control surfaces |
| `~/.claude/skills/...` symlinks | out of scope — skills come from the aaspai skills system, not from opencode |
| Sandbox/SSH cross-host lock | we run in-process; no remote-exec target |
| Workspace restore (sandbox round-trips) | we don't manage a sandbox |
| `OPENCODE_API_KEY` / per-provider env injection into the spawn | caller responsibility — we don't auto-inject API keys (use `setOpencodeAuth` instead) |
| `--command` sub-mode (shell-style command) | not part of aaspai's headless chat surface |

### Helpers (auth + session bookkeeping + file-system management)

```ts
import {
  setOpencodeAuth,
  removeOpencodeAuth,
  listOpencodeAuth,
  opencodeProviders,
  opencodeSessionList,
  opencodeSessionExport,
  opencodeSessionImport,
  opencodeStats,
  writeOpencodeMcpServers,
  writeOpencodeAgentFile,
  writeOpencodeSkill,
  addOpencodeProvider,
  getAuthFilePath,
  getOpencodeConfigDir,
} from "@aaspai/harness/drivers/opencode-cli";
```

| Helper | What it does | Pinned by |
| ------ | ------------ | --------- |
| `setOpencodeAuth(provider, apiKey, opts?)` | writes `~/.local/share/opencode/auth.json` (chmod 600) | `setOpencodeAuth writes a provider entry` |
| `removeOpencodeAuth(provider)` | removes one provider from `auth.json` | (same) |
| `listOpencodeAuth()` | `{ provider: { type, hasKey } }` (redacted) | (same) |
| `getAuthFilePath()` | returns the active `auth.json` path (env-overridable) | (same) |
| `opencodeProviders({ cli?, cwd? })` | calls `opencode providers` and parses | unit-tested via the failure path |
| `opencodeSessionList({ cli?, cwd? })` | calls `opencode session list --format json` | (same) |
| `opencodeSessionExport(id, { cli?, cwd? })` | calls `opencode session export <id>` | (same) |
| `opencodeSessionImport(json, { cli?, cwd? })` | calls `opencode session import` | (same) |
| `opencodeStats(id, { cli?, cwd? })` | calls `opencode stats <id> --format json` and parses | (same) |
| `writeOpencodeMcpServers(servers, { dir? })` | writes `~/.config/opencode/mcp.json` (merges) | `writeOpencodeMcpServers writes/merges` |
| `writeOpencodeAgentFile(name, body, { dir?, frontmatter? })` | writes `~/.config/opencode/agent/<name>.md` | `writeOpencodeAgentFile writes ... agent/<name>.md` |
| `writeOpencodeSkill(name, body, { dir?, frontmatter?, files? })` | writes `~/.config/opencode/skill/<name>/SKILL.md` + extras | `writeOpencodeSkill writes ... skill/<name>/` |
| `addOpencodeProvider(id, { baseUrl, apiKey?, models? }, { dir?, auth? })` | writes `~/.config/opencode/opencode.json` (merges) | `addOpencodeProvider writes ... opencode.json` |
| `getOpencodeConfigDir()` | returns the active config dir (env-overridable) | implicit in the helpers above |

All paths are env-overridable:

| Env var | Effect | Default |
| ------- | ------ | ------- |
| `AASPAI_OPENCODE_AUTH_PATH` | `auth.json` path | `~/.local/share/opencode/auth.json` |
| `AASPAI_OPENCODE_CONFIG_DIR` | base for mcp.json / agent/ / skill/ / opencode.json | `~/.config/opencode` |


### Test classes (97 tests total — 96 passed + 1 skipped)

| Group | Tests | What's covered |
| ----- | ----- | -------------- |
| `e2e: opencode_cli driver` | 60 | happy path, multi-text, error variants (auth/quota/refusal/generic/stderr), abort path, `--session` resume, `--fork`, every new flag (`--variant`, `--agent`, `--thinking`, `-c`, `--share`, `--pure`, `--auto`, `--log-level`, `--print-logs`, `--dir`, `--attach`, `--file` × N), streaming (`onRuntimeProgress` text/thinking/tool), env-var injection (XDG_CONFIG_HOME, OPENCODE_DISABLE_PROJECT_CONFIG), opencode.json (provider/permission/`dangerouslySkipPermissions`), models list parser, hello probe parser, OPENCODE_CLI env path, ProgramFiles fallback, malformed commandArgs, missing binary, cross-process lock, per-process serializer, model override, full sessionParams shape, resultJson metadata, setOpencodeAuth/removeOpencodeAuth/listOpencodeAuth (chmod 600 on POSIX), writeOpencodeMcpServers, writeOpencodeAgentFile, writeOpencodeSkill, addOpencodeProvider, opencodeSessionList/Export/Import/Stats error path, **mcpServers per-call injection (stdio + http), `ctx.tools.invoke` dispatcher (success path + thrown dispatcher → failed tool_result)** |
| `e2e: opencode_cli driver (real CLI smoke)` | 2 | real `opencode --version` invocation, real `opencode run "Respond with exactly: PONG"` against the installed binary |
| `opencode_cli per-process serialization` | 1 | `serialize()` + `acquireLock()` round-trip for `sessionParams` |
| `opencode_cli cross-process lock` | 1 | cross-process lock acquisition + release |
| `runProcess cancellation` | 2 | the underlying `runProcess` cancel + .cmd shim path |
| `harness contract` | 5 | protocol version, registry round-trip, every TranscriptEntry kind |
| `parseClaudeStreamLine` | 8 | Claude CLI event parser |
| `parseCodexStreamLine` | 4 | Codex CLI event parser |
| `redaction` | 3 | HOME + secret env redaction in command text |
| `dry_run_local adapter` | 3 | the headless dry-run adapter |
| `adapter registry` | 3 | registry + getAdapter round-trip |
| `claude_local config` | 2 | config schema round-trip |
| `codex_local config` | 1 | config schema round-trip |
| `buildAgentEnv` | 1 | AASPAI_* env injection |

### How to run

```sh
cd packages/harness

# Full suite (~7s)
pnpm test

# Only e2e (~7s)
pnpm test:e2e

# Typecheck
pnpm typecheck
```

The fake-CLI fixture is at `__tests__/fixtures/fake-opencode.cjs` and is
spawned via `process.execPath` so it works on every platform without needing
a `.cmd` shim.
