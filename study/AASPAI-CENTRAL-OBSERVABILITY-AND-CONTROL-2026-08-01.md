# AASPAI central observability and control study

Date: 2026-08-01

Status: local execution observer and deterministic company simulator implemented; real OpenCode run partially validated and failed before verified employee completion; central PostgreSQL/OTLP phase remains.

## Decision

AASPAI should not copy AI Observer as a second execution system. The execution database remains authoritative for company state, work items, attempts, sessions, approvals, artifacts, and recovery. Observability is a correlated read model over that state.

The system now uses three visible execution lanes:

| Lane | Meaning | Examples |
| --- | --- | --- |
| Company control | A durable mutation to company direction or structure | create milestone, bind/start process, hire, delegate |
| Task work | Work performed inside the agentic CLI runtime | read/write/bash, web search, browser, MCP and native CLI tools |
| System | Scheduler and runtime lifecycle | queued, workspace prepared, CLI started, progress, retry, cancelled, completed |

This distinction is mandatory. A native CLI saying “I hired someone” is task output, not a company mutation. Only a validated company-control command and its recorded effect can change company state.

## What was useful in `study/ai-observer`

AI Observer demonstrates five useful patterns:

1. Normalize provider-specific telemetry into logs, spans, metrics, and session events.
2. Correlate everything by session/trace before building the UI.
3. Support a live ingestion path and a durable historical/backfill path.
4. Present transcripts, trace waterfalls, logs, costs, and activity as different projections of the same run.
5. Preserve provider-native telemetry because operational metrics cannot always be reconstructed from transcript files.

It also has choices AASPAI should not copy directly:

- DuckDB is appropriate for a local analytics product, but AASPAI needs organization-scoped PostgreSQL for central multi-worker ingestion.
- A generic dashboard builder is less useful than a job-first operations view.
- File watching and OTLP must not become competing sources that duplicate events. AASPAI's worker stream is the guaranteed source; native OTLP is enrichment.
- WebSockets are unnecessary for the first browser transport. SSE already covers ordered server-to-browser updates, replay, heartbeat, and reconnect.

## Current end-to-end execution flow

```text
Founder/company goal
  -> CEO/manager durable work item
  -> scheduler creates attempt
  -> workspace manager creates isolated attempt workspace
  -> native Codex/OpenCode CLI session starts
  -> native/MCP task tools run inside that runtime
  -> structured company_action result is validated
  -> company.action.started is recorded
  -> CompanyCommandService applies the durable effect
  -> company.action.succeeded or failed is recorded with actual IDs
  -> delegated employee gets a new work item, session, runtime, and workspace
  -> manager process dispatches bounded work
  -> independent checker attempt verifies the result
  -> manager resumes through a durable wakeup
  -> milestone/project/objective roll up only from verified state
```

The manager is not kept running while delegated work executes. Delegation creates a separate durable session and runtime. Completion queues a manager continuation. Provider session resume is used when a timed-out/stalled CLI session can be safely continued.

## What is implemented now

### Correlated observer model

- Shared telemetry contracts require organization, attempt, work item, harness session, agent, runtime, trace, and span correlation fields.
- Correlation context uses `AsyncLocalStorage`; concurrent jobs cannot overwrite each other's identifiers.
- Execution and session events are merged into one ordered attempt timeline.
- Tools are classified by lane and origin: `aaspai`, `agent_native`, `mcp`, or `runtime`.
- The company-tool catalog describes the expected durable effects of each control.

### Durable company-control evidence

Each structured control records:

```text
company.action.started
  -> validated command and expected effects
company.action.succeeded
  -> actual milestone/process/agent/delegation/work-item IDs
or
company.action.failed
  -> durable failure reason
```

Company command wakeups that merely announce an already-applied mutation are now acknowledged instead of incorrectly becoming repository work. Discovery and process-run wakeups retain their executable behavior.

### Live execution view and control

The existing execution dashboard now shows:

- active and attention-needed attempt counts;
- current phase, elapsed time, last progress, and stalled state;
- company-control, task-work, and system events as separate badges;
- structured event payloads;
- SSE connected/reconnecting state;
- an interrupt action that persists cancellation and now reaches the live harness through worker polling.

The stream stops for terminal attempts. The execution database remains the source queried by this local projection.

### Agentic CLI supervision

- Production onboarding exposes only native Codex CLI and OpenCode CLI; the remaining direct HTTP chat-completion adapter was removed.
- OpenCode has no arbitrary wall-clock deadline.
- The harness monitors time since meaningful progress.
- A silent session can be interrupted and its provider session ID retained for resume.
- Persisted dashboard/API cancellation aborts the live process.
- Retry eligibility survives the harness/store terminal transition boundary.
- Attempt IDs are converted to one portable filesystem segment, including slash-containing durable wakeup IDs on Windows.

### Deterministic company simulation

`yarn test:simulate:company` uses `dry_run_local` but runs through the real database, scheduler, worker, workspace, company-command, delegation, process, verification, and roll-up paths.

The simulator can replay an exact JSON list from:

```text
AASPAI_SIMULATION_COMPANY_ACTIONS=[...]
```

This is intentionally a test-only deterministic instruction. It makes expensive model behavior irrelevant while testing orchestration invariants.

Latest passing evidence:

- Run: `workspace/company-simulation/acceptance/simulation/2026-08-02T08-51-19-723Z-551f19b6`
- CEO and delegated employee used separate sessions and attempts.
- Company controls: hire/delegate, milestone, define/start process.
- Six company lifecycle events were recorded.
- Process employee work completed in a separate attempt.
- An independent checker passed the process result.
- Manager run and operator workflow completed.
- Milestone and project roll-up completed.
- All company-control notification wakeups completed without creating fake repository work.

The simulation exposed and drove fixes for:

1. slash-containing attempt IDs producing invalid Windows paths;
2. general company process work silently defaulting to Git commit delivery;
3. mutation notification wakeups turning into unintended agent work;
4. a manager being selected as both maker and checker;
5. deterministic checker output missing the required structured verdict;
6. retry eligibility being lost after the harness had already persisted terminal state;
7. an operating-report heading being misread as an uncited lead.

## Control invariants

The following are release gates, not prompt suggestions:

1. Agent prose never mutates company state.
2. A required company action missing from the structured result fails the attempt.
3. Every applied company action has started and succeeded/failed events.
4. A delegated task has a distinct work item, attempt, session, workspace, and assigned agent.
5. Process work declares its work kind and delivery mode; general work is not forced through Git.
6. Maker and checker are independent.
7. Milestone/project/objective progress is derived from verified durable work.
8. A cancellation request reaches the running CLI.
9. No normal agentic CLI run is failed solely because a wall-clock duration elapsed.
10. Retrying or resuming never erases the original attempt/session evidence.

## Remaining production gaps

### P0: synchronous company-tool results

The CLI plugin currently collects structured actions and AASPAI applies them after the CLI exits. The attempt timeline proves the effect, but the agent cannot inspect the actual effect IDs during that same tool turn.

The next control-plane change should make `company_action` a host-executed tool broker call:

```text
CLI tool call
  -> authenticated attempt-scoped host endpoint
  -> authorize manager and validate command
  -> apply transaction
  -> record event
  -> return actual IDs to the same CLI session
```

This is required before agents can reliably chain several dependent company mutations in one reasoning turn.

### P0: manager callback into the same provider session

Delegated work already creates separate employee execution and queues a manager continuation. The continuation is durable, but it is not yet proven to reopen the original manager provider session and inject a completion notification containing the child evidence.

Required acceptance:

- manager session ends after delegation;
- child completes independently;
- a completion wakeup references parent session and child evidence;
- the manager resumes the same provider session ID;
- the manager decides the next milestone action from verified child state.

### P0: central telemetry service

The current observer reads the local execution database. The requested central production system still needs:

- `AASPAI_TELEMETRY_DATABASE_URL` PostgreSQL schema;
- authenticated normalized ingest and OTLP `/v1/logs`, `/v1/traces`, `/v1/metrics` endpoints;
- attempt-scoped opaque tokens stored only as hashes centrally and injected ephemerally;
- redaction, payload limits, batching, and cross-organization/attempt rejection;
- worker fallback ingestion plus native Codex/OpenCode OTLP enrichment;
- organization-scoped query and SSE replay APIs;
- 30-day content retention and 13-month metric rollups;
- idempotent backfill from execution/session events and raw output;
- alert persistence, deduplication, signed webhooks, and bounded retry.

Do not make this database authoritative for execution. If telemetry is unavailable, work continues and the worker retries telemetry delivery.

### P1: fleet and alert views

Still missing from the dashboard:

- worker heartbeat and fleet health;
- queue age/backlog;
- repeated failure and ingestion alerts;
- trace waterfall and logs explorer;
- token/cost time series across attempts;
- retention failure reporting.

### P1: real-agent release proof

The deterministic path is green. Two real local OpenCode ZedBlock runs are documented in [Real OpenCode ZedBlock validation](REAL-OPENCODE-ZEDBLOCK-VALIDATION-2026-08-01.md). They prove typed CEO delegation, separate employee execution, native web research, artifact creation, safety rejection, stalled-process interruption, provider identity retention, and recovery routing. They still fail before verified employee completion; the latest run ended on provider errors after the citation correction request.

A fresh real OpenCode ZedBlock run is still required to prove:

- native skill and company tool invocation;
- real public-web research through available native/MCP tools;
- no false citation rejection;
- successful work continuation after long-running progress supervision and interrupt/resume;
- final artifact verification and manager continuation.

Daytona should be tested after the local native-CLI run passes. Credentials must be supplied through environment/runtime configuration and must never be written to plans, telemetry, artifacts, or this repository.

## Recommended next implementation order

1. Prove same-provider-session manager callback in simulation.
2. Replace post-exit company action application with the authenticated host tool broker.
3. Run one full local OpenCode ZedBlock acceptance and fix only discrepancies from simulation.
4. Add PostgreSQL normalized telemetry ingestion with worker fallback.
5. Add native OTLP enrichment and backfill.
6. Add fleet/alerts/logs/traces UI.
7. Run Daytona and restart/recovery acceptance.

This order keeps company correctness dependent on the execution database and verified state, not on whether the telemetry service or dashboard is available.
