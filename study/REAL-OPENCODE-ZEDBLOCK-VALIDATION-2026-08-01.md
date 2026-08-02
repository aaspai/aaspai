# Real OpenCode ZedBlock validation

Date: 2026-08-01

Status: failed acceptance with confirmed orchestration and supervision evidence

## Scope

This run exercised the real local OpenCode CLI. It did not use a direct LLM API or the deterministic simulator.

Evidence root:

`workspace/company-real/zedblock/local/2026-08-01T05-58-14-549Z-f7076355`

Organization:

`org_company_local_2026-08-01T05-58-14-549Z-f7076355`

## What worked

1. The CEO completed a native OpenCode session.
2. The CEO used the typed `company_action` tool and applied `hire_and_delegate`.
3. `company.action.started` and `company.action.succeeded` recorded the durable effect.
4. A Growth Director, delegation, child work item, workflow, attempt, session, runtime, and isolated workspace were created.
5. The employee used the `zedblock-growth` skill and native `bash`/`curl` tools for public-web research.
6. CEO and employee execution were separate. The manager was not kept running while the employee worked.
7. The evidence policy correctly rejected an invented security claim:

   `ZedBlock uses enterprise-grade encryption, SOC 2 compliant infrastructure, and we never use client data for training.`

8. The worker retained full transcripts, tool events, last-progress timestamps, terminal causes, and provider session identities.
9. A silent CLI was interrupted after 15 minutes without meaningful progress. No arbitrary total job duration ended the run.
10. The Windows process tree was terminated, including descendants that inherited stdout.

## Attempt timeline

| Attempt | Result | Evidence |
| --- | --- | --- |
| CEO `attempt_75c1bbbd-488f-4f72-9936-693451aff5c0` | succeeded | typed hire/delegate action and durable child work |
| Employee 1 `attempt_5c92267c-92ac-4399-b553-c99a1a50348c` | lost | real work progressed, then the original worker wrapper died; startup recovery found it |
| Employee 2 `attempt_1b1c5799-84a2-49e3-bcb7-ad9244bfc397` | failed | evidence gate rejected an unsupported SOC 2/client-data claim |
| Employee 3 `attempt_3b91a3fb-3685-48ac-ba8e-b3c88f2a1bc2` | failed | a fresh retry received no verifier feedback and repeated the same unsupported claim |
| Employee 4 `attempt_1c9062d9-673f-4cfc-a1d4-4a37465fa97b` | failed | same-provider resume reached OpenCode, which returned an upstream server error |
| Employee 5 `attempt_0a56163c-e9f2-4524-b0de-83a3c892dcbf` | failed | repeated provider error; AASPAI preserved the true `opencode_cli_failed` cause and result artifact |
| Employee 6 `attempt_73c1b7ad-4942-42c9-85fb-ebc2a8127f63` | timed out | fresh session performed real web research, then stopped emitting progress and was interrupted |
| Employee 7 `attempt_19cc2cb4-ffd8-4b55-b43a-f77aea0fed06` | timed out | resume flag reached OpenCode, but the adapter omitted the new workspace directory and emitted no events |

Attempts 4 through 7 were controlled recovery probes after the original three-attempt acceptance had ended. The work item's retry ceiling was raised only inside this disposable evidence database to test recovery behavior.

## Fresh validation after the fixes

Run:

`workspace/company-real/zedblock/local/2026-08-02T05-09-01-901Z-18ae9e59`

The CEO again succeeded, used the typed company action, and delegated to a separate Growth Director session and workspace. The employee produced 78 native OpenCode events, researched real public sites with `bash`/`curl`, and created the declared growth files. The evidence gate reported that every lead did not contain an HTTP citation. The command transcript appears to show a public URL in each headed lead section, but the then-current failure path released those files before persisting them, so the exact final bytes cannot be audited. The correction resume reached OpenCode, but the provider returned `Unexpected server error` twice.

This run exposed and fixed one additional AASPAI bug: after the first provider error, the old `resumeSessionId` remained in the retry request, so the final retry reused the broken provider session. Retry construction now removes any prior provider ID and adds it back only when the current terminal cause is eligible for resume. The regression proves a provider failure forces a fresh session.

## Root causes and fixes

### Worker death and stale recovery

The Windows abort path killed only the CLI wrapper. A descendant retained stdout, so the harness never observed stream closure. The external test wrapper eventually closed stdout and the logger crashed on `EPIPE`.

Fixes:

- terminate the exact Windows child process tree with `taskkill /pid <pid> /t /f`;
- ignore logger writes after stdout/stderr becomes unavailable;
- reconcile stale attempts from their latest persisted session activity, not attempt start time;
- requeue retryable lost delegated work instead of failing its wakeup;
- repeat stale-claim recovery every five minutes, rather than only when the worker starts.

### Provider identity was persisted too late

The provider session ID appeared in early OpenCode JSON events but was written to the harness-session row only at terminal completion. A worker crash therefore lost the ID required for resume.

Fixes:

- persist the first observed provider session ID during streaming;
- preserve that ID when a terminal adapter result contains none;
- retain it in the completed execution event.

### Retry repeated unsafe output

The original retry created a new session with the original prompt. It did not include the evidence rejection, so the agent repeated the same invented security statement.

Fixes:

- attach the exact verification/provider failure to the retry prompt;
- resume the provider session for stalls and evidence corrections;
- clear stale retry payload state and fall back to a fresh session when the provider session itself returns `opencode_cli_failed`.

The evidence gate was not weakened.

### Failed runs masked their real error

Output persistence required every final declared artifact even when the CLI failed before creating files. That converted an OpenCode server error into a misleading missing-artifact error.

Fix:

- failed runs persist their terminal result and transcript without requiring missing final deliverables;
- any declared files that do exist are persisted even when the attempt fails or stalls;
- a new retry workspace restores the newest prior durable work files while retaining separate attempt, session, and runtime identities.

### OpenCode resume was directory-bound

OpenCode 1.18.5 stores a directory on each provider session. AASPAI resumed with `--session` from a new attempt workspace but did not pass `--dir`. The CLI emitted nothing until the silence monitor interrupted it.

Direct probe:

```text
opencode run --session <provider-session> --dir <current-workspace> --format json ...
```

With `--dir`, the same broken provider session returned its server error in 14 seconds instead of hanging for 15 minutes.

Fixes:

- local resume now passes `--dir <current workspace>`;
- a no-event resume retains the requested provider session ID instead of inventing an `oc_*` replacement.

## Current release decision

The system is not yet allowed to claim a fully autonomous real-company pass. The deterministic company orchestration gate passes, and the real run proves the control/supervision paths above, but the employee work never reached verified completion.

Remaining release blockers:

1. Obtain a real local OpenCode run whose corrected employee artifacts pass verification; the 2026-08-02 run reached artifact creation but ended on provider errors after the citation correction request.
2. Prove the manager completion callback reopens the original manager provider session with child evidence.
3. Prove failed/stalled declared-artifact carry-over in a fresh real run. The automated gate now persists existing partial files and restores them into the next isolated workspace.
4. Prove the same recovery behavior in Daytona after local acceptance passes.
5. Build the separate PostgreSQL/OTLP central telemetry service, fleet alerts, retention, and backfill described in the observability study.

## Automated gates added

- Windows descendant-process cancellation regression
- latest-session-activity stale reconciliation regression
- stale delegated-work requeue with provider identity regression
- failed-attempt artifact persistence and isolated retry-workspace restoration regression
- early provider-identity persistence and terminal preservation regressions
- retry prompt contains verifier feedback and provider identity regression
- logger closed-pipe regression
- OpenCode resume forwards `--session` and `--dir`
- OpenCode no-event resume preserves provider identity

No Daytona credential or other secret is stored in this report, source, plans, sessions, or artifacts.
