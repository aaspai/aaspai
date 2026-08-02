# Autonomous Company End-to-End Validation

Date: 2026-07-31  
Branch: `test/autonomous-company-e2e`  
Baseline commit: `6f93aa0` (`feat: complete autonomous company orchestration baseline`)

## Verdict

The original validation found two P0 release blockers: onboarding could not select a runnable agentic runtime, and a CEO could falsely complete without performing required typed company actions.

Remediation state on 2026-07-31: **the local agentic-CLI company loop now runs from CEO to hired employee with durable evidence. The broader multi-project autonomous-company release gate is still open.**

The runtime contract is now explicit: AaspAI never calls an LLM provider API directly. Every reasoning session is executed by an authenticated local `codex` or `opencode` CLI process. Provider credentials remain owned by those CLIs.

## Remediation update

### Fixed

- Company-control work now carries machine-enforced, project-scoped typed-action requirements.
- Requirements survive wakeup-to-work-item conversion and use one-to-one matching, so one action cannot satisfy several projects.
- A successful CLI exit is rejected before completion when any required action is missing.
- OpenCode managers submit actions through the native `company_action` CLI tool.
- Codex managers submit the same strictly validated action envelope through the final `AASPAI_COMPANY_ACTIONS=...` line.
- Onboarding offers only authenticated local Codex and OpenCode CLI sessions and blocks launch until the selected CLI reports ready.
- The selected CLI and managed local runtime are persisted in company policy, generated agent definitions, discovery wakes, and staffing wakes.
- Managed local execution disables environment passthrough and retains the existing workspace, tool, governance, artifact, and audit controls.
- All direct provider-gateway, OpenRouter, and attempt-token execution paths added during the earlier remediation were removed.
- OpenCode agents have native web search plus a bounded `browser_snapshot` tool. Browser access is read-only, public-HTTPS-only, DNS-pinned, private-address-blocked, limited to 30 seconds, and capped at 100 KB.
- Codex agents receive the native `web_search` tool together with governed shell, patch, and image-view tools.
- CLI-owned `.opencode_cli` and `.codex` files are excluded from work-product evidence accounting.
- Delegation now preserves milestone, process-binding, and parent-work lineage without sending those fields through the strict routing-request parser.
- The real-company fixture registers its CEO authorization and follows delegated work across its child workflow.
- The founder name and role layout defect is fixed.

### Verified

- Company tests: 16/16 passed.
- Worker tests: 20/20 passed.
- Execution tests: 48/48 passed.
- Harness tests: 137 passed, 1 skipped.
- Web, worker, company, execution, and harness type checks passed.
- Immutable dependency install passed.
- The real local OpenCode CLI run proved:
  - the CEO loaded its pinned company skill;
  - `company_action(hire_and_delegate)` was invoked;
  - the employee definition, project assignment, authority edge, delegation, child workflow, child work item, and wakeup were persisted;
  - the employee loaded its pinned skill;
  - native CLI tools created, hashed, and read back the required artifact;
  - CEO and employee attempts both completed with local runtime identities;
  - reports, tool events, raw output, usage, artifacts, and state transitions were durable.

Passing evidence:

- [Result](../workspace/company-real/acceptance/local/2026-07-31T07-59-34-213Z-63fd8926/RESULT.md)
- [Summary](../workspace/company-real/acceptance/local/2026-07-31T07-59-34-213Z-63fd8926/SUMMARY.json)
- `workspace/company-real/acceptance/local/2026-07-31T07-59-34-213Z-63fd8926/state.db`

### Release gate still open

Required final acceptance:

1. Run the real ZedBlock scenario through public-web research and verify its lead list, campaign, sales playbook, and operating report.
2. Run discovery, founder approval, minimum project creation, project-manager appointment, milestone/process creation, employee work, verification, scheduling, and reporting in one uninterrupted multi-project acceptance.
3. Interrupt an active manager/employee CLI session, restart the worker, and verify recovery without duplicate actions.
4. Exercise the Codex CLI path end to end, including its strict typed-action result line.
5. Exercise Daytona only after Codex or OpenCode is natively installed and authenticated inside the remote runtime. The Daytona key may provision the runtime; it must not become a substitute direct-LLM credential.

### Remaining post-release hardening

- Add CLI-session budgets, rate limits, and per-company/model allowlists.
- Verify founder approval, connector idempotency, and audit behavior for each real external-action connector before granting it to agents.
- Add interactive multi-page browser automation only when a company process requires it; the current research browser intentionally returns a bounded rendered DOM and cannot click or submit.
- Validate Daytona account egress and native CLI authentication for the deployed account tier.

## Historical validation below

The remaining sections preserve the failures observed before remediation. They are retained as regression context and do not describe the current runtime contract.

## Test 1: Founder onboarding through the web product

### Scenario

Created a local founder account and entered:

- Company: ZedBlock E2E
- Mission: build a B2B blockchain-infrastructure growth engine
- Objectives:
  - build 100 target accounts and create 20 sales-qualified leads in 90 days
  - publish 24 technical posts and reach 5,000 relevant monthly impressions
  - run a measurable 25-prospect-per-week founder-outreach process
- Boundaries: no spending, external messages, hiring commitments, publishing, or production changes without approval
- First CEO priority: research the best niche, propose the minimum project portfolio, and request founder approval
- Provider/model: OpenCode CLI and an offered OpenCode model

### Observed flow

1. Sign-up succeeded.
2. The login-to-onboarding transition took roughly 20 seconds.
3. Company, mission, boundaries, goals, CEO priority, provider, and model could be entered.
4. The page reported OpenCode as `Ready`.
5. Launch failed with HTTP 503:

   ```json
   {
     "error": "Daytona and the attempt-credential gateway must be configured before launching a real company."
   }
   ```

6. No company discovery, portfolio proposal, staffing session, project execution, or approval request started.

### Root cause

Readiness is checked at the wrong layer:

- the UI reports that the OpenCode CLI is available;
- onboarding does not collect or validate an execution runtime;
- the API unconditionally requires Daytona and the credential gateway for a real CLI provider;
- generated non-dry-run agent definitions hard-code Daytona;
- governed CLI agents are correctly prohibited from running directly on the host;
- Docker is a supported isolated runtime in the execution layer but is not available in onboarding.

The product-generated CEO configuration also leaves `adapterConfig` empty. It does not configure the attempt-gateway provider/model mapping used by the working real-E2E harness.

### Product/UX defects

- Runtime setup is absent even though runtime is a required launch dependency.
- `Ready` means “CLI installed,” not “company can execute.”
- The page promises Daytona execution before Daytona has been configured.
- The founder name and role render as `Aaspai QA FounderFounder` without separation.
- CSS preload warnings appear in the browser console.

### Evidence

- [Login screenshot](../output/playwright/01-login.png)
- [Completed onboarding screenshot](../output/playwright/02-onboarding-filled.png)
- `apps/web/app/api/onboarding/route.ts`
- `apps/web/components/onboarding-wizard.tsx`
- `apps/web/lib/workspace-bootstrap.ts`
- `apps/web/app/(dashboard)/onboarding/page.tsx`
- `packages/execution/src/harness-runner.ts`

## Test 2: Real ZedBlock CEO in an isolated Docker runtime

### Scenario

Built the existing real-company Docker acceptance image and ran:

```text
node node_modules/tsx/dist/cli.mjs apps/worker/__tests__/real-e2e/run-real-company.ts docker zedblock
```

This used:

- a real OpenCode CLI session;
- a real model through the attempt-credential gateway;
- an isolated Docker workspace;
- the `company-operator` skill;
- a typed `company_action` custom tool;
- durable SQLite execution state and artifacts.

### Expected flow

```text
CEO session
  -> company_action(hire_and_delegate)
  -> persist employee and delegation
  -> create employee work item
  -> employee executes research/campaign/playbook work
  -> verify artifacts
  -> report to manager/CEO
```

### Actual flow

```text
CEO session
  -> loads company-operator skill
  -> attempts a denied write to /tmp
  -> prints hire JSON in markdown
  -> claims the Growth Director was delegated
  -> exits 0
  -> parent work item is marked completed
  -> no company action exists
  -> no employee or delegation exists
  -> test waits six minutes and fails
```

### Durable-state evidence

- CEO attempt: `succeeded`
- Parent work item: `completed`
- `resultJson.companyActions`: `[]`
- Employee work items: `0`
- Hired service agents: `0`
- Delegations: `0`
- Employee artifacts: `0`
- Final test result: `Employee work did not complete within six minutes`

Run evidence:

- [Result](../workspace/company-real/zedblock/docker/2026-07-31T05-43-33-176Z-fc774caa/RESULT.md)
- [CEO result JSON](../workspace/company-real/zedblock/docker/2026-07-31T05-43-33-176Z-fc774caa/artifacts/attempt_cb71ec33-b58f-40cc-b1fa-392ff05654f8/result.json)
- `workspace/company-real/zedblock/docker/2026-07-31T05-43-33-176Z-fc774caa/state.db`

## Confirmed orchestration defect

The CEO staffing requirement is prompt-only.

`CompanyCommandService.activate()` tells the CEO to call `hire_and_delegate`, but the wake payload and resulting work item do not contain a machine-enforced required-action invariant.

The shared executor already knows how to reject missing actions through:

```text
workItem.metadata.requiredCompanyActions
```

However:

- activation does not persist `hire_and_delegate` as required;
- legacy wakeup-to-work-item conversion drops action requirements;
- the real-company acceptance parent work item does not declare them;
- only delegated project-manager work currently declares required actions.

This affects the normal product path as well as the test harness.

The `company_action` tool was independently confirmed discoverable by OpenCode. Its first tool-catalog load took approximately 40 seconds because the test image does not preinstall the custom-tool helper package. The model chose not to invoke the available tool; the orchestration layer then incorrectly accepted the response.

## What currently works

- Durable goals, projects, work items, workflow runs, attempts, sessions, events, and raw outputs
- Isolated Docker execution
- Ephemeral gateway credential issue and revocation
- CEO skill materialization
- Manager authorization check before exposing `company_action`
- Typed company-action parsing and validation
- Employee/delegation creation code when a valid action is submitted
- Required-action enforcement for newly delegated project managers
- Audit and artifact locations sufficient to reconstruct this failure

## Missing or incorrect pieces, in remediation order

### P0: Make false completion impossible

1. Persist required company actions with every company-control wakeup.
2. Carry those requirements into all generated or existing work items.
3. Reject an attempt before marking work complete when a required action is absent.
4. Treat textual claims as untrusted output; only typed actions and verified artifacts can change state.
5. Make the real-company E2E fail immediately on a missing CEO action instead of waiting six minutes.

Acceptance:

- a CEO response that says “hired” without `hire_and_delegate` ends as failed/blocked;
- no parent work item can be `completed` while its required typed action is missing.

### P0: Make onboarding launchable

1. Add an explicit isolated-runtime choice and readiness check.
2. Support Docker for local development and Daytona for remote execution.
3. Validate the selected runtime, gateway, credential flow, provider, and model before showing `Ready`.
4. Store the selected runtime in company policy and generated agent configuration.
5. Generate the gateway-backed OpenCode provider configuration used by real execution.

Acceptance:

- a fresh founder can launch locally with Docker without Daytona;
- a Daytona launch cannot be submitted until Daytona and gateway checks pass;
- launch proceeds into CEO discovery and produces a reviewable portfolio proposal.

### P1: Complete the autonomous operating loop

After the P0 gates pass, verify:

1. discovery produces a typed/strictly parsed portfolio proposal;
2. founder approval activates only approved projects;
3. CEO staffs each unstaffed project with the minimum manager set;
4. each manager creates measurable milestones and one minimal process;
5. managers delegate bounded employee work with artifact and evidence requirements;
6. completed work is independently verified before project progress changes;
7. failed/blocked work creates a visible manager or founder request;
8. process runs schedule the next bounded cycle;
9. reports and approvals appear in the founder UI;
10. memory/knowledge updates cite verified run evidence.

### P1: Remove execution latency traps

- Preinstall or cache `@opencode-ai/plugin` in real runtime images.
- Replace the fixed six-minute employee wait with state-aware failure:
  - fail immediately when required CEO actions are missing;
  - continue waiting only when delegated work actually exists and is progressing.
- Surface signup/onboarding transition progress instead of leaving the login page apparently unchanged.

### P2: Product polish

- Render founder name and role with a separator.
- Resolve CSS preload warnings.
- Replace internal “operator” wording with “manager” in user-facing surfaces while keeping any internal compatibility names as implementation details.

## Required rerun sequence

1. Unit test: required wakeup actions survive wakeup-to-work-item conversion.
2. Worker test: a successful CLI exit with missing required action is rejected.
3. Worker test: a valid `hire_and_delegate` creates agent, assignment, delegation, child work, and wakeup.
4. Browser test: Docker onboarding readiness and launch.
5. Full real ZedBlock Docker run.
6. Full real ZedBlock Daytona run.
7. Restart/recovery test while CEO or employee work is in progress.

The release gate is the real ZedBlock run completing with durable evidence for every state transition and no state transition based solely on agent prose.

## 2026-08-01 remediation status

The deterministic orchestration gate now passes through the real scheduler, worker, workspace, company commands, delegation, process, independent verification, and manager roll-up paths:

- Evidence: [simulation result](../workspace/company-simulation/acceptance/simulation/2026-08-02T08-51-19-723Z-551f19b6/RESULT.md)
- Timeline: [classified timeline](../workspace/company-simulation/acceptance/simulation/2026-08-02T08-51-19-723Z-551f19b6/TIMELINE.json)
- Current observability/control study: [AASPAI central observability and control](AASPAI-CENTRAL-OBSERVABILITY-AND-CONTROL-2026-08-01.md)

This clears the deterministic system gate. It does not replace the required fresh real OpenCode ZedBlock run or the pending central PostgreSQL/OTLP telemetry service.

## 2026-08-02 real local OpenCode status

The fresh run at `workspace/company-real/zedblock/local/2026-08-02T05-09-01-901Z-18ae9e59` again proved typed CEO delegation and separate native employee execution. The employee researched public sites and created the growth files, but verification rejected missing per-lead HTTP citations. OpenCode then returned provider errors during correction. AASPAI incorrectly reused that broken provider session once; retry construction now clears stale provider IDs and the regression proves the next attempt starts fresh.

## 2026-08-01 real local OpenCode status

The real local ZedBlock run has now been executed. It proved CEO typed delegation, separate employee execution, native public-web research, evidence-policy enforcement, stalled-process interruption, provider-session persistence, and retry routing. It did not reach verified employee completion and therefore remains a failed acceptance.

Detailed evidence, root causes, implemented fixes, and remaining release blockers are recorded in [Real OpenCode ZedBlock validation](REAL-OPENCODE-ZEDBLOCK-VALIDATION-2026-08-01.md).
