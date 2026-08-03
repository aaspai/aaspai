import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@aaspai/observability", () => ({
  COMPANY_TOOL_CATALOG: {},
  getLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}));

vi.mock("@aaspai/sessions", () => ({
  Sessions: class {
    execute = vi.fn();
  },
}));

describe("delegated work ownership and manager callback", () => {
  const originalEnv = { ...process.env };
  let tempDirectory = "";

  afterEach(async () => {
    try {
      const { closeDefaultDb } = await import("@aaspai/db");
      await closeDefaultDb();
    } catch {
      // best effort
    }
    if (tempDirectory) rmSync(tempDirectory, { recursive: true, force: true });
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("claims the assigned child, preserves lineage, and resumes the manager with verified evidence", async () => {
    tempDirectory = mkdtempSync(join(tmpdir(), "aaspai-delegation-callback-"));
    process.env.AASPAI_DB = `sqlite:${join(tempDirectory, "state.db")}`;
    const { agentAttempts, eq, getDefaultDb, loops, runMigrations, sessions, wakeups } =
      await import("@aaspai/db");
    const handle = getDefaultDb();
    runMigrations(handle);
    const timestamp = new Date().toISOString();
    await handle.db.insert(loops).values({
      id: "manual",
      organizationId: "org_test",
      patternId: "manual",
      configJson: "{}",
      gateJson: "{}",
      budgetJson: "{}",
      scheduleJson: "{}",
      paused: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const { AutonomousWorkExecutor, ExecutionStore } = await import("@aaspai/execution");
    const store = new ExecutionStore(handle.db);
    const goal = await store.createGoal({ organizationId: "org_test", title: "Grow" });
    const project = await store.createProject({
      organizationId: "org_test",
      goalId: goal.id,
      title: "Growth",
    });
    const repository = await store.createRepository({
      organizationId: "org_test",
      projectId: project.id,
      purpose: "project",
      provider: "local",
      localPath: tempDirectory,
    });
    const revision = await store.createDefinitionRevision({
      organizationId: "org_test",
      repositoryId: repository.id,
      commitSha: "abcdef1",
      sourcePath: "agents/manager",
      contentHash: "manager-definition",
    });
    const managerRun = await store.createWorkflowRun({
      organizationId: "org_test",
      goalId: goal.id,
      definitionRevisionId: revision.id,
      idempotencyKey: "manager-run",
    });
    const managerWork = await store.createWorkItem({
      organizationId: "org_test",
      goalId: goal.id,
      projectId: project.id,
      repositoryId: repository.id,
      workflowRunId: managerRun.id,
      assignedAgentId: "agent/manager",
      title: "Manage growth",
      definitionRevisionId: revision.id,
      workKind: "general",
      deliveryMode: "none",
      idempotencyKey: "manager-work",
      status: "ready",
    });
    const managerAttempt = await store.createAttempt({
      organizationId: "org_test",
      workflowRunId: managerRun.id,
      workItemId: managerWork.id,
      agentId: "agent/manager",
      harness: "opencode_cli",
    });
    const managerSession = await store.createHarnessSession({
      organizationId: "org_test",
      agentId: "agent/manager",
      adapter: "opencode_cli",
      prompt: "Manage growth",
    });
    await store.linkHarnessSession(managerAttempt.id, managerSession.id);
    await store.setHarnessSessionProviderIdentity(managerSession.id, "provider_manager_original");
    const managerWorkspacePath = join(tempDirectory, "manager-workspace");
    mkdirSync(managerWorkspacePath);
    const managerWorkspace = await store.createWorkspace({
      organizationId: "org_test",
      attemptId: managerAttempt.id,
      repositoryId: repository.id,
      path: managerWorkspacePath,
      branchName: `disposable/${managerAttempt.id}`,
      baseCommitSha: "abcdef1",
      status: "ready",
    });

    const childRun = await store.createWorkflowRun({
      organizationId: "org_test",
      goalId: goal.id,
      definitionRevisionId: revision.id,
      sourceType: "manager_delegation",
      sourceId: managerWork.id,
      idempotencyKey: "child-run",
    });
    const childWork = await store.createWorkItem({
      organizationId: "org_test",
      goalId: goal.id,
      projectId: project.id,
      repositoryId: repository.id,
      workflowRunId: childRun.id,
      parentWorkItemId: managerWork.id,
      assignedAgentId: "agent/researcher",
      title: "Research the market",
      description: "Produce a sourced report",
      definitionRevisionId: revision.id,
      workKind: "general",
      deliveryMode: "none",
      idempotencyKey: "child-work",
      status: "ready",
      maxAttempts: 3,
      governance: {
        verification: {
          required: true,
          checkerAgentId: "agent/checker",
          checkerHarness: "dry_run_local",
          acceptanceCriteria: [
            { id: "criterion/evidence", description: "Evidence supports the result" },
          ],
          minEvidence: 1,
        },
      },
    });
    const { WorkerDaemon } = await import("../src/daemon.js");
    const daemon = new WorkerDaemon({ organizationId: "org_test" });
    await daemon.queueDelegatedWork(
      {
        type: "hire_and_delegate",
        agentId: "agent/researcher",
        title: "Researcher",
        role: "researcher",
        description: "Research markets",
        workTitle: childWork.title,
        workDescription: childWork.description,
      },
      childWork,
      "dry_run_local",
      {
        agentId: "agent/manager",
        attemptId: managerAttempt.id,
        workItemId: managerWork.id,
        harnessSessionId: managerSession.id,
        providerSessionId: "provider_manager_original",
        workspaceId: managerWorkspace.id,
      },
    );
    const [delegatedWake] = await handle.db.select().from(wakeups);
    const delegatedPayload = JSON.parse(delegatedWake?.payloadJson ?? "{}") as Record<
      string,
      string
    >;
    delegatedPayload.managerProviderSessionId = "stale_captured_provider_session";
    await handle.db
      .update(wakeups)
      .set({ payloadJson: JSON.stringify(delegatedPayload) })
      .where(eq(wakeups.id, delegatedWake?.id ?? "missing"));
    const delegatedSession = (await handle.db.select().from(sessions)).find(
      (row) => row.wakeupId === delegatedWake?.id,
    );
    expect(delegatedSession?.parentSessionId).toBe(managerSession.id);

    const wrongOwnerAttempt = await store.createAttempt({
      organizationId: "org_test",
      workflowRunId: childRun.id,
      workItemId: childWork.id,
      agentId: "agent/intruder",
      harness: "dry_run_local",
    });
    await expect(store.claimWorkItem(childWork.id, wrongOwnerAttempt.id)).resolves.toBe(false);
    await store.transitionAttempt(wrongOwnerAttempt.id, "preparing");
    await store.transitionAttempt(wrongOwnerAttempt.id, "running");
    await store.transitionAttempt(wrongOwnerAttempt.id, "failed");

    const childResult = await new AutonomousWorkExecutor(store).execute({
      organizationId: "org_test",
      workflowRunId: childRun.id,
      workItemId: childWork.id,
      agentId: "agent/researcher",
      harness: "dry_run_local",
      parentAttemptId: delegatedPayload.parentAttemptId,
      runProvider: async () => "succeeded",
    });
    expect(childResult.attempt.parentAttemptId).toBe(managerAttempt.id);
    await expect(store.getWorkItem(childWork.id)).resolves.toMatchObject({
      assignedAgentId: "agent/researcher",
      claimedByAttemptId: childResult.attempt.id,
      claimedAt: expect.any(String),
      status: "awaiting_verification",
    });

    const verification = await store.getVerificationForWorkItem(childWork.id);
    expect(verification).not.toBeNull();
    const checker = await store.createCheckerAttempt({
      verificationId: verification?.id ?? "missing",
      agentId: "agent/checker",
      harness: "dry_run_local",
    });
    await store.startCheckerAttempt(checker.id);
    await store.transitionAttempt(checker.id, "succeeded");
    const evidence = await store.createArtifact({
      organizationId: "org_test",
      attemptId: checker.id,
      kind: "test_result",
      path: "evidence/check.json",
      mediaType: "application/json",
      sizeBytes: 2,
      sha256: "0".repeat(64),
    });
    await store.submitVerification({
      verificationId: verification?.id ?? "missing",
      checkerAttemptId: checker.id,
      status: "passed",
      summary: "Sources and output verified",
      evidenceIds: [evidence.id],
    });

    await daemon.recoverDelegationCallbacks();
    await daemon.recoverDelegationCallbacks();
    const allWakeups = await handle.db.select().from(wakeups);
    const callbackWakeups = allWakeups.filter((row) => row.triggerDetail === "delegation-verified");
    expect(callbackWakeups).toHaveLength(1);
    const callbackWake = callbackWakeups[0];
    expect(callbackWake).toBeDefined();
    const callbackPayload = JSON.parse(callbackWake?.payloadJson ?? "{}") as {
      resumeSessionId?: string;
      resumeWorkspaceId?: string;
      mustResumeSession?: boolean;
      evidenceIds?: string[];
      parentAttemptId?: string;
      workItemId?: string;
    };
    expect(callbackPayload).toMatchObject({
      resumeSessionId: "provider_manager_original",
      resumeWorkspaceId: managerWorkspace.id,
      mustResumeSession: true,
      parentAttemptId: childResult.attempt.id,
    });
    expect(callbackPayload.evidenceIds).toEqual(
      expect.arrayContaining([verification?.id, evidence.id]),
    );
    const callbackSession = (await handle.db.select().from(sessions)).find(
      (row) => row.wakeupId === callbackWake?.id,
    );
    expect(callbackSession).toMatchObject({
      agentId: "agent/manager",
      parentSessionId: managerSession.id,
    });
    await expect(store.getWorkItem(callbackPayload.workItemId ?? "missing")).resolves.toMatchObject(
      {
        assignedAgentId: "agent/manager",
        parentWorkItemId: childWork.id,
        status: "ready",
      },
    );

    const failedRun = await store.createWorkflowRun({
      organizationId: "org_test",
      goalId: goal.id,
      definitionRevisionId: revision.id,
      sourceType: "manager_delegation",
      sourceId: managerWork.id,
      idempotencyKey: "failed-child-run",
    });
    const failedWork = await store.createWorkItem({
      organizationId: "org_test",
      goalId: goal.id,
      projectId: project.id,
      repositoryId: repository.id,
      workflowRunId: failedRun.id,
      parentWorkItemId: managerWork.id,
      assignedAgentId: "agent/researcher",
      title: "Test the rejected segment",
      description: "Return failure evidence",
      definitionRevisionId: revision.id,
      workKind: "general",
      deliveryMode: "none",
      idempotencyKey: "failed-child-work",
      status: "ready",
      maxAttempts: 1,
    });
    await daemon.queueDelegatedWork(
      {
        type: "hire_and_delegate",
        agentId: "agent/researcher",
        title: "Researcher",
        role: "researcher",
        description: "Research markets",
        workTitle: failedWork.title,
        workDescription: failedWork.description,
      },
      failedWork,
      "dry_run_local",
      {
        agentId: "agent/manager",
        attemptId: managerAttempt.id,
        workItemId: managerWork.id,
        harnessSessionId: managerSession.id,
        providerSessionId: "provider_manager_original",
        workspaceId: managerWorkspace.id,
      },
    );
    const failedResult = await new AutonomousWorkExecutor(store).execute({
      organizationId: "org_test",
      workflowRunId: failedRun.id,
      workItemId: failedWork.id,
      agentId: "agent/researcher",
      harness: "dry_run_local",
      parentAttemptId: managerAttempt.id,
      runProvider: async () => "failed",
    });
    expect(failedResult.workItem).toMatchObject({
      status: "failed",
      blockedReason: "failed without retry eligibility",
    });

    await daemon.recoverDelegationCallbacks();
    await daemon.recoverDelegationCallbacks();
    const blockedRun = await store.createWorkflowRun({
      organizationId: "org_test",
      goalId: goal.id,
      definitionRevisionId: revision.id,
      sourceType: "manager_delegation",
      sourceId: managerWork.id,
      idempotencyKey: "blocked-child-run",
    });
    const blockedWork = await store.createWorkItem({
      organizationId: "org_test",
      goalId: goal.id,
      projectId: project.id,
      repositoryId: repository.id,
      workflowRunId: blockedRun.id,
      parentWorkItemId: managerWork.id,
      assignedAgentId: "agent/researcher",
      title: "Policy-blocked research",
      description: "This work cannot start",
      definitionRevisionId: revision.id,
      workKind: "general",
      deliveryMode: "none",
      idempotencyKey: "blocked-child-work",
      status: "ready",
    });
    await daemon.queueDelegatedWork(
      {
        type: "hire_and_delegate",
        agentId: "agent/researcher",
        title: "Researcher",
        role: "researcher",
        description: "Research markets",
        workTitle: blockedWork.title,
        workDescription: blockedWork.description,
      },
      blockedWork,
      "dry_run_local",
      {
        agentId: "agent/manager",
        attemptId: managerAttempt.id,
        workItemId: managerWork.id,
        harnessSessionId: managerSession.id,
        providerSessionId: "provider_manager_original",
        workspaceId: managerWorkspace.id,
      },
    );
    await store.updateWorkItemStatus(blockedWork.id, "blocked", {
      blockedReason: "execution policy denied the assignment",
    });
    await daemon.recoverDelegationCallbacks();
    const terminalCallbacks = (await handle.db.select().from(wakeups)).filter((row) =>
      ["delegation-verified", "delegation-terminal"].includes(row.triggerDetail ?? ""),
    );
    expect(terminalCallbacks).toHaveLength(3);
    const failedCallbackPayload =
      terminalCallbacks
        .map(
          (row) =>
            JSON.parse(row.payloadJson) as {
              childStatus?: string;
              resumeSessionId?: string;
              workItemId?: string;
            },
        )
        .find((payload) => payload.childStatus === "failed") ?? {};
    expect(failedCallbackPayload).toMatchObject({
      childStatus: "failed",
      resumeSessionId: "provider_manager_original",
    });
    const blockedCallbackPayload = terminalCallbacks
      .map((row) => JSON.parse(row.payloadJson) as Record<string, unknown>)
      .find((payload) => payload.childStatus === "blocked");
    expect(blockedCallbackPayload).toMatchObject({
      parentAttemptId: managerAttempt.id,
      resumeSessionId: "provider_manager_original",
    });
    await expect(
      store.getWorkItem(String(blockedCallbackPayload?.workItemId ?? "missing")),
    ).resolves.toMatchObject({
      metadata: { delegationCallback: { childAttemptId: null, childStatus: "blocked" } },
    });

    const staleRun = await store.createWorkflowRun({
      organizationId: "org_test",
      goalId: goal.id,
      definitionRevisionId: revision.id,
      sourceType: "manager_delegation",
      sourceId: managerWork.id,
      idempotencyKey: "stale-child-run",
    });
    const staleWork = await store.createWorkItem({
      organizationId: "org_test",
      goalId: goal.id,
      projectId: project.id,
      repositoryId: repository.id,
      workflowRunId: staleRun.id,
      parentWorkItemId: managerWork.id,
      assignedAgentId: "agent/researcher",
      title: "Recover an unstarted delegation",
      definitionRevisionId: revision.id,
      workKind: "general",
      deliveryMode: "none",
      idempotencyKey: "stale-child-work",
      status: "ready",
      maxAttempts: 1,
    });
    await daemon.queueDelegatedWork(
      {
        type: "hire_and_delegate",
        agentId: "agent/researcher",
        title: "Researcher",
        role: "researcher",
        description: "Research markets",
        workTitle: staleWork.title,
        workDescription: staleWork.description,
      },
      staleWork,
      "dry_run_local",
      {
        agentId: "agent/manager",
        attemptId: managerAttempt.id,
        workItemId: managerWork.id,
        harnessSessionId: managerSession.id,
        providerSessionId: "provider_manager_original",
        workspaceId: managerWorkspace.id,
      },
    );
    const oldClaimedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const staleWake = (await handle.db.select().from(wakeups)).find(
      (row) => (JSON.parse(row.payloadJson) as { workItemId?: string }).workItemId === staleWork.id,
    );
    await handle.db
      .update(wakeups)
      .set({ status: "claimed", claimedAt: oldClaimedAt })
      .where(eq(wakeups.id, staleWake?.id ?? "missing"));
    await daemon.recoverStaleClaims();
    await expect(store.getWorkItem(staleWork.id)).resolves.toMatchObject({ status: "failed" });

    const lostRun = await store.createWorkflowRun({
      organizationId: "org_test",
      goalId: goal.id,
      definitionRevisionId: revision.id,
      sourceType: "manager_delegation",
      sourceId: managerWork.id,
      idempotencyKey: "lost-final-child-run",
    });
    const lostWork = await store.createWorkItem({
      organizationId: "org_test",
      goalId: goal.id,
      projectId: project.id,
      repositoryId: repository.id,
      workflowRunId: lostRun.id,
      parentWorkItemId: managerWork.id,
      assignedAgentId: "agent/researcher",
      title: "Recover a final lost delegation",
      definitionRevisionId: revision.id,
      workKind: "general",
      deliveryMode: "none",
      idempotencyKey: "lost-final-child-work",
      status: "ready",
      maxAttempts: 1,
    });
    await daemon.queueDelegatedWork(
      {
        type: "hire_and_delegate",
        agentId: "agent/researcher",
        title: "Researcher",
        role: "researcher",
        description: "Research markets",
        workTitle: lostWork.title,
        workDescription: lostWork.description,
      },
      lostWork,
      "dry_run_local",
      {
        agentId: "agent/manager",
        attemptId: managerAttempt.id,
        workItemId: managerWork.id,
        harnessSessionId: managerSession.id,
        providerSessionId: "provider_manager_original",
        workspaceId: managerWorkspace.id,
      },
    );
    const lostAttempt = await store.createAttempt({
      organizationId: "org_test",
      workflowRunId: lostRun.id,
      workItemId: lostWork.id,
      agentId: "agent/researcher",
      harness: "dry_run_local",
      parentAttemptId: managerAttempt.id,
    });
    await store.claimWorkItem(lostWork.id, lostAttempt.id);
    await store.transitionAttempt(lostAttempt.id, "preparing");
    await store.transitionAttempt(lostAttempt.id, "running");
    await handle.db
      .update(agentAttempts)
      .set({ heartbeatAt: oldClaimedAt, startedAt: oldClaimedAt })
      .where(eq(agentAttempts.id, lostAttempt.id));
    const lostWake = (await handle.db.select().from(wakeups)).find(
      (row) => (JSON.parse(row.payloadJson) as { workItemId?: string }).workItemId === lostWork.id,
    );
    await handle.db
      .update(wakeups)
      .set({ status: "claimed", claimedAt: oldClaimedAt })
      .where(eq(wakeups.id, lostWake?.id ?? "missing"));
    await daemon.recoverStaleClaims();
    await expect(store.getAttempt(lostAttempt.id)).resolves.toMatchObject({ status: "lost" });
    await expect(store.getWorkItem(lostWork.id)).resolves.toMatchObject({ status: "failed" });

    const recoveredWakeups = await handle.db.select().from(wakeups);
    const staleCallback = recoveredWakeups.find(
      (row) => row.reason?.includes(staleWork.id) && row.triggerDetail === "delegation-terminal",
    );
    const lostCallback = recoveredWakeups.find(
      (row) => row.reason?.includes(lostWork.id) && row.triggerDetail === "delegation-terminal",
    );
    expect(staleCallback).toBeDefined();
    expect(lostCallback).toBeDefined();
    const staleCallbackPayload = JSON.parse(staleCallback?.payloadJson ?? "{}") as {
      workItemId?: string;
    };
    const lostCallbackPayload = JSON.parse(lostCallback?.payloadJson ?? "{}") as {
      workItemId?: string;
    };
    await expect(
      store.getWorkItem(staleCallbackPayload.workItemId ?? "missing"),
    ).resolves.toMatchObject({
      metadata: { delegationCallback: { childAttemptId: null, childStatus: "failed" } },
    });
    await expect(
      store.getWorkItem(lostCallbackPayload.workItemId ?? "missing"),
    ).resolves.toMatchObject({
      metadata: {
        delegationCallback: { childAttemptId: lostAttempt.id, childStatus: "failed" },
      },
    });

    await store.updateWorkItemStatus(callbackPayload.workItemId ?? "missing", "completed");
    await daemon.releaseRetainedManagerWorkspace(managerWorkspace.id, managerAttempt.id);
    await expect(store.getWorkspace(managerWorkspace.id)).resolves.toMatchObject({
      status: "ready",
    });
    await store.updateWorkItemStatus(failedCallbackPayload.workItemId ?? "missing", "failed");
    await store.updateWorkItemStatus(
      String(blockedCallbackPayload?.workItemId ?? "missing"),
      "failed",
    );
    await store.updateWorkItemStatus(lostCallbackPayload.workItemId ?? "missing", "failed");

    const liveLockOwner = await store.createAttempt({
      organizationId: "org_test",
      workflowRunId: managerRun.id,
      workItemId: managerWork.id,
      agentId: "agent/manager",
      harness: "opencode_cli",
      attemptNumber: 2,
    });
    await store.transitionAttempt(liveLockOwner.id, "preparing");
    await store.transitionAttempt(liveLockOwner.id, "running");
    await store.transitionAttempt(liveLockOwner.id, "lost");
    const liveLock = await store.acquireResourceLock({
      organizationId: "org_test",
      resourceType: "workspace",
      resourceId: managerWorkspace.id,
      ownerAttemptId: liveLockOwner.id,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(liveLock).not.toBeNull();
    await handle.db
      .update(wakeups)
      .set({ status: "claimed", claimedAt: oldClaimedAt })
      .where(eq(wakeups.id, staleCallback?.id ?? "missing"));
    await daemon.recoverStaleClaims();
    await expect(
      store.getWorkItem(staleCallbackPayload.workItemId ?? "missing"),
    ).resolves.toMatchObject({ status: "failed" });
    await expect(store.getWorkspace(managerWorkspace.id)).resolves.toMatchObject({
      status: "ready",
    });
    await store.releaseResourceLock(liveLock?.id ?? "missing");
    await daemon.recoverDelegationCallbacks();
    await daemon.recoverDelegationCallbacks();
    await expect(store.getWorkspace(managerWorkspace.id)).resolves.toMatchObject({
      status: "released",
    });
  });
});
