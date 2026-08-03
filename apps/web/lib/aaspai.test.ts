import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveCompanyDiscovery,
  resolveExecutionScope,
  resolveLatestPortfolioProposal,
  summarizeWakeupCounts,
} from "./aaspai";

test("labels discovery attempts as company setup without hiding technical lineage", () => {
  assert.equal(resolveExecutionScope("wakeup", "start_discovery"), "Company setup / CEO discovery");
  assert.equal(
    resolveExecutionScope("wakeup", "activate_company"),
    "Company operation / CEO staffing",
  );
  assert.equal(
    resolveExecutionScope("manager_delegation", null),
    "Project setup / delegated manager",
  );
  assert.equal(resolveExecutionScope("operator", null), "Project process / assigned work");
  assert.equal(
    resolveExecutionScope("delegation_callback", null),
    "Project review / manager callback",
  );
  assert.equal(resolveExecutionScope("loop", null), null);
});

test("counts claimed wakeups as running without using session states", () => {
  assert.deepEqual(
    summarizeWakeupCounts([
      { status: "queued" },
      { status: "claimed" },
      { status: "failed" },
      { status: "completed" },
      { status: "coalesced" },
    ]),
    { queued: 1, running: 1, failed: 1, completed: 1 },
  );
});

test("correlates discovery wakeup, run, attempt, and the real harness failure", () => {
  const discoveryWakeup = {
    id: "wakeup_discovery",
    status: "claimed",
    payloadJson: JSON.stringify({ command: "start_discovery" }),
    requestedAt: "2026-08-03T00:00:00.000Z",
    finishedAt: null,
    error: "wakeup wrapper error",
    sessionId: null,
  };
  const rows = {
    lifecycleStatus: "discovery",
    wakeups: [
      {
        ...discoveryWakeup,
        id: "wakeup_notification",
        payloadJson: JSON.stringify({ command: "validate_company" }),
        requestedAt: "2026-08-03T00:01:00.000Z",
      },
      discoveryWakeup,
    ],
    runs: [
      { id: "run_unrelated", sourceType: "manual", sourceId: null },
      { id: "run_discovery", sourceType: "wakeup", sourceId: discoveryWakeup.id },
    ],
    attempts: [
      {
        id: "attempt_discovery",
        workflowRunId: "run_discovery",
        harnessSessionId: "session_discovery",
        status: "running",
        error: "attempt wrapper error",
        attemptNumber: 1,
        createdAt: "2026-08-03T00:00:01.000Z",
      },
    ],
    sessions: [
      {
        id: "session_discovery",
        status: "failed",
        errorMessage: "OpenCode CLI authentication failed",
      },
    ],
  };

  assert.deepEqual(resolveCompanyDiscovery(rows), {
    status: "failed",
    wakeupId: "wakeup_discovery",
    workflowRunId: "run_discovery",
    attemptId: "attempt_discovery",
    harnessSessionId: "session_discovery",
    error: "OpenCode CLI authentication failed",
    requestedAt: discoveryWakeup.requestedAt,
    finishedAt: null,
  });
  assert.equal(resolveCompanyDiscovery({ ...rows, lifecycleStatus: "review" }).status, "review");
  assert.equal(resolveCompanyDiscovery({ ...rows, lifecycleStatus: "active" }).status, "active");
  assert.equal(
    resolveCompanyDiscovery({
      ...rows,
      wakeups: [{ ...discoveryWakeup, status: "queued" }],
      runs: [],
      attempts: [],
      sessions: [],
    }).status,
    "queued",
  );
  assert.equal(
    resolveCompanyDiscovery({
      ...rows,
      sessions: [{ id: "session_discovery", status: "running", errorMessage: null }],
    }).status,
    "running",
  );

  const retried = resolveCompanyDiscovery({
    ...rows,
    wakeups: [
      {
        ...discoveryWakeup,
        id: "wakeup_retry",
        status: "claimed",
        requestedAt: "2026-08-03T00:02:00.000Z",
        error: null,
      },
      discoveryWakeup,
    ],
    attempts: [
      {
        id: "attempt_discovery",
        workflowRunId: "run_discovery",
        harnessSessionId: "session_discovery",
        status: "failed",
        error: "old failure",
        attemptNumber: 1,
        createdAt: "2026-08-03T00:00:01.000Z",
      },
      {
        id: "attempt_retry",
        workflowRunId: "run_discovery",
        harnessSessionId: "session_retry",
        status: "running",
        error: null,
        attemptNumber: 2,
        createdAt: "2026-08-03T00:02:01.000Z",
      },
    ],
    sessions: [
      { id: "session_discovery", status: "failed", errorMessage: "old harness failure" },
      { id: "session_retry", status: "running", errorMessage: null },
    ],
  });
  assert.equal(retried.status, "running");
  assert.equal(retried.attemptId, "attempt_retry");
  assert.equal(retried.harnessSessionId, "session_retry");
  assert.equal(retried.error, null);
});

test("reads the latest durable CEO portfolio proposal for founder review", () => {
  const proposal = resolveLatestPortfolioProposal([
    {
      action: "portfolio_proposal",
      actorId: "agent/ceo",
      occurredAt: "2026-08-03T00:00:00.000Z",
      metadataJson: JSON.stringify({ summary: "Old proposal", projects: [] }),
    },
    {
      action: "portfolio_proposal",
      actorId: "agent/ceo",
      occurredAt: "2026-08-03T00:01:00.000Z",
      metadataJson: JSON.stringify({
        summary: "Focus on qualified demand first.",
        evidence: ["session/session_discovery"],
        projects: [
          {
            goalId: "goal/leads",
            title: "Qualified lead engine",
            description: "Build the smallest measurable acquisition loop.",
            managerAgentId: null,
          },
        ],
      }),
    },
  ]);

  assert.deepEqual(proposal, {
    summary: "Focus on qualified demand first.",
    evidence: ["session/session_discovery"],
    projects: [
      {
        goalId: "goal/leads",
        title: "Qualified lead engine",
        description: "Build the smallest measurable acquisition loop.",
        managerAgentId: null,
      },
    ],
    actorId: "agent/ceo",
    occurredAt: "2026-08-03T00:01:00.000Z",
  });
});
