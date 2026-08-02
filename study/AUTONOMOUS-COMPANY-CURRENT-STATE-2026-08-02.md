# Autonomous company: current state and next development gate

Date: 2026-08-02
Branch: `test/autonomous-company-e2e`

## Verdict

The **local OpenCode autonomous-company core now works end to end**.

The final acceptance proved this sequence with real CLI sessions and durable state:

```text
Founder work item
  -> CEO OpenCode session
  -> governed company_action(hire_and_delegate)
  -> separate employee work item, workspace, attempt, and OpenCode session
  -> employee work tools and artifact
  -> separate read-only checker attempt and OpenCode session
  -> passed verification
  -> manager callback work item
  -> new durable callback session resuming the original CEO provider conversation
  -> all work, workflows, wakeups, attempts, and locks terminal/settled
```

This is not yet the complete product vision. It is a passing local orchestration kernel. Actual web onboarding through discovery and founder approval, multi-project operation, recurring routines, remote-runtime company controls, and the proposed central telemetry platform remain open.

## Final evidence

### Deterministic simulation

- Status: passed
- Target: `simulation`
- CEO, employee, checker, manager callback, milestone, and process paths completed.
- Four distinct durable sessions were recorded.
- Local evidence directory: `workspace/company-simulation/acceptance/simulation/2026-08-02T17-32-38-387Z-ebe4611e`. Runtime evidence is intentionally excluded from Git; the verified result is summarized above.

### Real local OpenCode company

- Status: passed
- Duration: 259 seconds
- CEO provider session: `ses_03c768ad2ffe4SZzz5SjIPWT2L`
- Employee provider session: `ses_03c753e2bffekGc5mE8j08IeZv`
- Checker provider session: `ses_03c73dffbffeC7gucq1xfqUgLr`
- Manager callback used a new durable session row and resumed the exact CEO provider session.
- The employee created `employee-proof.txt`, ran `sha256sum`, read the file back, and returned the required marker.
- The checker independently read and hashed the delivered artifact.
- Verified SHA-256: `caa9531585d2668945f2374b63633d5606f19ecac3b4cfeb90c92780893d1b7c`.
- All four attempts succeeded; all three work items and three wakeups completed; verification passed; no resource lock remained active.
- Local evidence directory: `workspace/company-real/acceptance/local/2026-08-02T17-33-08-744Z-2d179c4b`. Runtime transcripts and the state database are intentionally excluded from Git; the durable IDs, counts, and verified hash are recorded above.

### Repository verification

- `yarn test`: passed across every workspace.
- Worker: 45/45 tests passed.
- Execution: 64/64 tests passed.
- Harness: 141 passed, 1 skipped.
- `yarn typecheck`: passed.
- `yarn lint`: passed with three existing optional-chain suggestions in `packages/company/src/command-service.ts`.
- `git diff --check`: passed.
- No direct LLM-provider endpoint was found under `apps/` or `packages/`; reasoning continues to run through agentic CLI adapters.
- The supplied Daytona credential was not found in the repository or generated evidence.

## What is implemented now

### 1. Governed company controls

Managers can submit these typed company actions:

- `hire_and_delegate`
- `create_milestone`
- `define_and_start_process`

For local Codex/OpenCode runs, company changes cross an attempt-scoped loopback broker. It enforces organization, attempt, agent, and resumed-provider-session identity; a short-lived bearer token; bounded input; one action per request; semantic deduplication; action budget; secret rejection/redaction; serialized application; retry after transient failure; and draining before evidence validation and attempt terminalization.

Unknown JSON fields are projected out before fingerprinting, so adding a nonce cannot duplicate a mutation. Failed mutations are not permanently cached. Broker shutdown is idempotent and cannot race an accepted action past terminal evidence.

### 2. Company tools versus work tools

The system now distinguishes:

- **Company control:** typed mutations that change staff, delegation, milestones, or process state.
- **Task work:** native CLI tools such as skill loading, read/write, shell, patching, web search, and browser snapshot inside an assigned runtime.
- **System:** claims, plans, workspaces, session lifecycle, heartbeats, verification, recovery, and callbacks.

This distinction is emitted into the observed timeline and shown in the attempt UI.

### 3. Delegation and manager sleep/resume

- Delegation creates a child workflow/work item owned by the hired employee.
- The employee gets a separate attempt, durable harness session, and workspace.
- The manager CLI is not kept running while delegated work executes.
- After a terminal verified result, the system creates a callback work item and a new durable callback session.
- The callback resumes the exact manager provider-native conversation and retained manager workspace.
- Parent attempt/session/work-item lineage is durable.

### 4. Verification and roll-up

- Maker evidence is persisted before terminal completion.
- A checker receives the immutable delivery, uses a separate attempt/session, and cannot silently replace maker evidence.
- Only verified work rolls up as completed.
- Failed or lost delegated work still settles the delegation and wakes the manager with the terminal outcome.

The real acceptance used the CEO configuration in a separate checker role/session. A dedicated QA/checker agent identity is still preferable for production independence.

### 5. Long-running CLI execution and recovery

- There is no arbitrary total duration deadline on the real company acceptance.
- Active attempts emit durable heartbeats and renew all owned leases.
- Staleness is based on last real CLI progress, not total wall-clock duration.
- A stuck session is interrupted and retried through provider-session resume.
- Lost-attempt recovery uses a new attempt and durable session while preserving prior events/results.
- Only a pristine pre-created queued session can activate in place. Running, terminal, or evidenced sessions are immutable and produce a child session on retry.
- A durable session cannot be linked to two attempts.
- Atomic claim checks prevent cross-organization, cross-workflow, wrong-goal, and wrong-agent execution.

### 6. Onboarding runtime/tool defaults

- The product presents operator agents to users as company **managers**.
- Onboarding can select authenticated local OpenCode or Codex CLI execution.
- Generated CEO/company-manager definitions include company-operation skills.
- OpenCode can receive native search/work tools and the bounded `browser_snapshot` tool; Codex can receive its native web-search path.
- No direct provider API credential is persisted as a company plan credential.

### 7. Current observability and controls

Implemented locally:

- execution overview with active and attention-needed attempt counts;
- goal progress and ready-work controls;
- stale-claim/recovery control;
- live attempt page with phase, last-progress age, lineage, runtime/workspace/session identity;
- system/company/task-work event lanes with structured inputs/outputs;
- artifacts, transcript link, terminal errors;
- SSE refresh with connected/reconnecting state;
- interrupt/cancel control;
- durable raw output, session events, tool events, execution events, attempts, work items, and artifacts in the execution database.

Not implemented from the central-observability proposal:

- separate PostgreSQL telemetry database;
- OTLP logs/traces/metrics ingestion;
- remote attempt-scoped telemetry tokens and HTTPS ingestion;
- fleet summary, logs explorer, trace waterfall, metric series, alert rules, webhook delivery, retention, and backfill;
- SSE replay via `Last-Event-ID` across a central telemetry stream.

The current execution database remains the source of truth and the current dashboard is useful for one installation. It is not yet the proposed production fleet observability system.

## Remaining gaps, in order

### Gate 1: real product lifecycle

Run one uninterrupted acceptance beginning at the actual web onboarding UI:

```text
create company and goals
  -> CEO discovery/research
  -> proposed minimum project portfolio
  -> founder review/approval
  -> project creation
  -> manager appointment
  -> milestones and processes
  -> employee delegation/work
  -> verification
  -> report and next-cycle decision
```

The current real acceptance starts from a prepared company fixture. It proves the execution kernel, not the entire founder product journey.

### Gate 2: realistic multi-project company

- Run the ZedBlock example with lead generation, social/content, and outreach projects.
- Exercise real public-web research and citation validation.
- Require project managers rather than placing all management under the CEO.
- Use a dedicated checker/QA agent.
- Prove parallel employees and several completed delegations without premature manager-workspace release.

No outreach, account changes, purchases, or other external side effects should occur without explicit founder approval.

### Gate 3: complete manager control surface

The native manager tool currently covers only three mutation types. Add the minimum Paperclip-style coordination surface when the product flow needs it:

- inspect company/project/work status;
- comment/thread communication on work items;
- request founder approval or direction;
- request/inspect tool and connector readiness;
- block/unblock/escalate work;
- create a report and propose the next milestone/cycle.

Do not add a second task system. These should operate on the existing work-item, approval, event, and company-command models.

### Gate 4: recurring autonomous operation

- Persist schedules/routines that launch a new process cycle.
- Prove at least two cycles with idempotent inputs and no duplicate work.
- Add cycle-level budgets, stop conditions, and founder report cadence.
- Keep failed verification visible and prevent unsupported progress roll-up.

### Gate 5: remote runtime parity

Docker, SSH, and Daytona do not yet have the local broker's synchronous company-control path. The smallest safe architecture is:

```text
remote CLI
  -> central HTTPS attempt-scoped action endpoint
  -> durable action request/result row
  -> active worker claims and applies through existing applyCompanyActions()
  -> synchronous result returned to the remote CLI
```

Before enabling this, remove secret exposure from remote command/argv construction. Then add opaque hashed short-lived tokens bound to organization + attempt, leases/idempotency, worker fallback/recovery, and Docker/SSH/Daytona integration tests. The Daytona credential alone is not CLI authentication and must never be used as a direct-LLM credential.

### Gate 6: central observability

Build the separate PostgreSQL/OTLP telemetry system only after the product lifecycle and remote action bridge are stable. Reuse the current normalized observer and execution IDs. Mirror; do not replace; the durable execution records.

### Gate 7: runtime acceptance matrix

- Real Codex local company action/delegation/callback run.
- Worker restart during CEO, employee, checker, and callback phases.
- Forced transient company-action failure followed by successful retry.
- Long silent-but-healthy work, genuine stuck work, interrupt, and provider resume.
- Docker, SSH, and Daytona only after their secure bridge is implemented.

## Paperclip comparison after this work

AASPAI now has the Paperclip-style primitives that were blocking the local core: atomic ownership, durable task/session lineage, heartbeats, lost-work recovery, separate delegated executions, manager continuation, live attempt inspection, and interrupt/recovery controls.

Paperclip remains ahead in founder-facing task coordination, comments/threads, approvals and interaction UX, budgets, recurring routines, remote sandbox maturity, and broad operational UI. AASPAI remains ahead in explicit company goals/projects/milestones/process semantics and mandatory maker/checker verified roll-up.

The next phase should keep the current AASPAI domain model and port only the missing proven control-plane behaviors. Replacing it with a parallel Paperclip clone would recreate the same integration problem.

## Release statement

Safe statement:

> AASPAI can run a controlled local autonomous-company work cycle through OpenCode CLI, including governed hiring/delegation, separate employee execution, durable evidence, independent verification, and exact manager-session continuation.

Unsafe statement:

> AASPAI is already a complete unattended multi-project autonomous company across local and remote runtimes.

The first statement is now backed by passing simulation, real CLI evidence, database invariants, and the full repository test suite. The second still requires Gates 1-7.
