import { describe, expect, it } from "vitest";
import {
  agentAttemptSchema,
  assertValidAttemptTransition,
  executionPlanSchema,
  isValidAttemptTransition,
} from "../src/execution";

const now = "2026-07-23T12:00:00.000Z";

describe("execution contracts", () => {
  it("accepts a complete execution plan", () => {
    const result = executionPlanSchema.safeParse({
      id: "plan_1",
      organizationId: "org_1",
      definitionRevisionId: "rev_1",
      workItemId: "work_1",
      attemptId: "attempt_1",
      sourceSnapshot: {
        repositoryId: "repo_1",
        commitSha: "0123456789abcdef",
        branchName: "main",
        capturedAt: now,
      },
      target: { kind: "local", cwd: "F:/workspace/worktrees/work_1", envPassthrough: false },
      harness: "dry_run_local",
      prompt: "Run the task",
      createdAt: now,
    });

    expect(result.success).toBe(true);
  });

  it("rejects an attempt with an invalid status transition", () => {
    expect(isValidAttemptTransition("queued", "succeeded")).toBe(false);
    expect(() => assertValidAttemptTransition("queued", "succeeded")).toThrow(
      "Invalid agent attempt transition",
    );
    expect(
      agentAttemptSchema.safeParse({
        id: "attempt_1",
        organizationId: "org_1",
        workflowRunId: "run_1",
        workItemId: "work_1",
        agentId: "agent/ceo",
        harness: "dry_run_local",
        status: "running",
        createdAt: now,
      }).success,
    ).toBe(true);
  });
});
