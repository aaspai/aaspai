import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  companyControlEvents,
  companyProfiles,
  createDb,
  eq,
  executionVerifications,
  executionWorkItems,
  goals,
  milestones,
  processBindings,
  projectAssignments,
  projectObjectives,
  projects,
  repositories,
  runMigrations,
  wakeups,
} from "@aaspai/db";
import { ExecutionStore } from "@aaspai/execution";
import { afterEach, describe, expect, it } from "vitest";
import { CompanyCommandService } from "../src/command-service";
import { CompanyFullExportService } from "../src/full-export";
import { ProcessImprovementService } from "../src/process-improvement";
import { StrategicReadModelService } from "../src/strategic";

const resources: Array<{ close: () => Promise<void>; root: string }> = [];
const previousDb = process.env.AASPAI_DB;

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.close();
    await rm(resource.root, { recursive: true, force: true });
  }
  if (previousDb === undefined) delete process.env.AASPAI_DB;
  else process.env.AASPAI_DB = previousDb;
});

describe("StrategicReadModelService", () => {
  it("assembles tenant-scoped objectives, projects, assignments, and milestones", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaspai-company-strategic-"));
    const handle = createDbFor(root);
    resources.push({ close: handle.close, root });
    runMigrations(handle);
    const now = new Date().toISOString();

    await handle.db.insert(companyProfiles).values({
      organizationId: "org_a",
      description: "A company",
      lifecycleStatus: "active",
      ceoAgentId: "agent/ceo",
      policyJson: JSON.stringify({ maxProjects: 3 }),
      createdAt: now,
      updatedAt: now,
    });
    await handle.db.insert(goals).values({
      id: "goal_a",
      organizationId: "org_a",
      title: "Grow",
      successCriteriaJson: JSON.stringify(["40 SQLs"]),
      createdAt: now,
      updatedAt: now,
    });
    await handle.db.insert(goals).values({
      id: "goal:loops:org_a",
      organizationId: "org_a",
      title: "Company loop execution",
      createdAt: now,
      updatedAt: now,
    });
    await handle.db.insert(projects).values({
      id: "project_a",
      organizationId: "org_a",
      goalId: "goal_a",
      title: "Pipeline",
      managerAgentId: "agent/manager",
      budgetJson: JSON.stringify({ usd: 100 }),
      createdAt: now,
      updatedAt: now,
    });
    await handle.db.insert(projects).values({
      id: "project:loops:org_a",
      organizationId: "org_a",
      goalId: "goal:loops:org_a",
      title: "Loop work",
      createdAt: now,
      updatedAt: now,
    });
    await handle.db.insert(projectObjectives).values({
      id: "link_a",
      organizationId: "org_a",
      projectId: "project_a",
      goalId: "goal_a",
      isPrimary: true,
      createdAt: now,
      updatedAt: now,
    });
    await handle.db.insert(projectAssignments).values({
      id: "assignment_a",
      organizationId: "org_a",
      projectId: "project_a",
      agentId: "agent/manager",
      role: "manager",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await handle.db.insert(milestones).values({
      id: "milestone_a",
      organizationId: "org_a",
      projectId: "project_a",
      title: "Define ICP",
      sequence: 1,
      acceptanceJson: JSON.stringify({ evidence: 100 }),
      createdAt: now,
      updatedAt: now,
    });

    const summary = await new StrategicReadModelService(handle.db).getSummary("org_a");
    expect(summary.profile?.lifecycleStatus).toBe("active");
    expect(summary.objectives).toHaveLength(1);
    expect(summary.projects).toHaveLength(1);
    expect(summary.objectives[0]).toMatchObject({ id: "goal_a", projectCount: 1 });
    expect(summary.projects[0]).toMatchObject({
      id: "project_a",
      objectiveIds: ["goal_a"],
      processBindingCount: 0,
    });
    expect(summary.projects[0]?.assignments[0]?.role).toBe("manager");
    expect(summary.projects[0]?.milestones[0]?.acceptance).toEqual({ evidence: 100 });
    expect((await new StrategicReadModelService(handle.db).getSummary("org_b")).projects).toEqual(
      [],
    );
  });

  it("routes setup, validation, portfolio, staffing, and milestones through idempotent commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaspai-company-commands-"));
    const handle = createDbFor(root);
    resources.push({ close: handle.close, root });
    runMigrations(handle);
    const commands = new CompanyCommandService(handle.db);
    const now = new Date().toISOString();
    await handle.db.insert(goals).values({
      id: "goal:loops:org_commands",
      organizationId: "org_commands",
      title: "Company loop execution",
      createdAt: now,
      updatedAt: now,
    });
    await commands.execute({
      type: "setup_company",
      organizationId: "org_commands",
      actorId: "founder",
      idempotencyKey: "setup",
      description: "A focused company",
      ceoAgentId: "agent/ceo",
      operatorAgentId: "agent/operator",
      objectives: [{ title: "Reach product-market fit", successCriteria: ["10 customers"] }],
    });
    await commands.execute({
      type: "setup_company",
      organizationId: "org_commands",
      actorId: "founder",
      idempotencyKey: "setup",
      description: "A focused company",
      ceoAgentId: "agent/ceo",
      operatorAgentId: "agent/operator",
      objectives: [{ title: "Reach product-market fit", successCriteria: ["10 customers"] }],
    });
    await commands.execute({
      type: "validate_company",
      organizationId: "org_commands",
      actorId: "founder",
      idempotencyKey: "validate",
    });
    await expect(
      commands.execute({
        type: "create_project",
        organizationId: "org_commands",
        actorId: "agent/ceo",
        idempotencyKey: "project-before-approval",
        goalId: (await commands.getSummary("org_commands")).objectives[0]!.id,
        title: "Must wait",
      }),
    ).rejects.toThrow("approved active portfolio");
    await commands.execute({
      type: "start_discovery",
      organizationId: "org_commands",
      actorId: "founder",
      idempotencyKey: "discovery",
    });
    const discoveryWakeup = (await handle.db.select().from(wakeups)).find((wakeup) =>
      wakeup.payloadJson.includes('"command":"start_discovery"'),
    );
    expect(discoveryWakeup?.payloadJson).not.toContain("goal:loops:org_commands");
    expect(discoveryWakeup?.payloadJson).not.toContain("Company loop execution");
    const objective = (await commands.getSummary("org_commands")).objectives[0];
    expect(objective).toBeDefined();
    await expect(
      commands.execute({
        type: "submit_portfolio_proposal",
        organizationId: "org_commands",
        actorId: "agent/ceo",
        idempotencyKey: "internal-proposal",
        summary: "Do not expose internal execution lineage.",
        evidence: ["artifact/discovery"],
        projects: [
          {
            goalId: "goal:loops:org_commands",
            title: "Internal loop work",
            description: "This should never become a company project.",
            managerAgentId: null,
          },
        ],
      }),
    ).rejects.toThrow("objective not found");
    const proposalCommand = {
      type: "submit_portfolio_proposal",
      organizationId: "org_commands",
      actorId: "agent/ceo",
      idempotencyKey: "proposal",
      summary: "Start with a customer pipeline.",
      evidence: ["artifact/discovery"],
      projects: [],
    } as const;
    await commands.execute(proposalCommand);
    await expect(commands.execute(proposalCommand)).resolves.toMatchObject({ status: "review" });
    expect(
      (await handle.db.select().from(companyControlEvents)).filter(
        (event) => event.correlationId === proposalCommand.idempotencyKey,
      ),
    ).toHaveLength(1);
    expect(
      (await handle.db.select().from(wakeups)).filter(
        (wakeup) =>
          wakeup.idempotencyKey === `control:org_commands:${proposalCommand.idempotencyKey}`,
      ),
    ).toHaveLength(1);
    await commands.execute({
      type: "activate_company",
      organizationId: "org_commands",
      actorId: "founder",
      idempotencyKey: "activate",
      approved: true,
    });
    const project = await commands.execute({
      type: "create_project",
      organizationId: "org_commands",
      actorId: "agent/ceo",
      idempotencyKey: "project-1",
      goalId: objective!.id,
      title: "Customer pipeline",
    });
    await commands.execute({
      type: "appoint_project_manager",
      organizationId: "org_commands",
      actorId: "agent/ceo",
      idempotencyKey: "manager-1",
      projectId: project.id!,
      agentId: "agent/growth",
    });
    await expect(
      commands.execute({
        type: "create_milestone",
        organizationId: "org_commands",
        actorId: "agent/other",
        idempotencyKey: "unauthorized-milestone",
        projectId: project.id!,
        title: "Should fail",
        sequence: 2,
      }),
    ).rejects.toThrow("accountable project manager");
    const createdMilestone = await commands.execute({
      type: "create_milestone",
      organizationId: "org_commands",
      actorId: "agent/growth",
      idempotencyKey: "milestone-1",
      projectId: project.id!,
      title: "Define ICP",
      sequence: 1,
      acceptance: { evidence: 1 },
    });
    await expect(
      commands.execute({
        type: "evaluate_project",
        organizationId: "org_commands",
        actorId: "agent/growth",
        idempotencyKey: "project-unverified",
        projectId: project.id!,
        evidence: ["artifact/unverified"],
      }),
    ).rejects.toThrow("passed verification");
    await seedVerifiedEvidence(
      handle.db,
      "org_commands",
      objective!.id,
      project.id!,
      createdMilestone.id!,
      ["artifact/icp", "artifact/project-review"],
    );
    await commands.execute({
      type: "evaluate_project",
      organizationId: "org_commands",
      actorId: "agent/growth",
      idempotencyKey: "project-incomplete",
      projectId: project.id!,
      evidence: ["artifact/project-review"],
    });
    expect((await commands.getSummary("org_commands")).projects[0]?.status).toBe("staffed");
    const milestone = (await commands.getSummary("org_commands")).projects[0]?.milestones[0];
    await commands.execute({
      type: "record_milestone_evaluation",
      organizationId: "org_commands",
      actorId: "agent/growth",
      idempotencyKey: "milestone-accepted",
      projectId: project.id!,
      milestoneId: milestone!.id,
      status: "accepted",
      evidence: ["artifact/icp"],
      rationale: "Acceptance criteria verified.",
    });
    await commands.execute({
      type: "evaluate_project",
      organizationId: "org_commands",
      actorId: "agent/growth",
      idempotencyKey: "project-complete",
      projectId: project.id!,
      evidence: ["artifact/project-review"],
    });
    await commands.execute({
      type: "record_measurement",
      organizationId: "org_commands",
      actorId: "agent/ceo",
      idempotencyKey: "objective-measurement",
      goalId: objective!.id,
      metricKey: "customers",
      value: 10,
      observedAt: new Date().toISOString(),
      sourceType: "artifact",
      sourceId: "artifact/icp",
      evidence: ["artifact/icp"],
    });
    await commands.execute({
      type: "evaluate_objective",
      organizationId: "org_commands",
      actorId: "agent/ceo",
      idempotencyKey: "objective-complete",
      goalId: objective!.id,
      evidence: ["artifact/project-review"],
    });
    const summary = await commands.getSummary("org_commands");
    expect(summary.objectives).toHaveLength(1);
    expect(summary.projects[0]).toMatchObject({
      managerAgentId: "agent/growth",
      status: "completed",
    });
    expect(summary.projects[0]?.milestones).toHaveLength(1);
    const thread = await commands.execute({
      type: "create_thread",
      organizationId: "org_commands",
      actorId: "user/owner",
      idempotencyKey: "work-thread",
      entityType: "work",
      entityId: "work-demo",
      title: "Delivery handoff",
    });
    await commands.execute({
      type: "add_thread_message",
      organizationId: "org_commands",
      actorId: "user/owner",
      idempotencyKey: "work-message",
      threadId: thread.id!,
      body: "Please review this @agent/growth",
    });
    expect(
      await handle.db.select().from(wakeups).where(eq(wakeups.organizationId, "org_commands")),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ agentId: "agent/growth" })]));
  });

  it("persists the selected runtime and project-scoped staffing requirements", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaspai-company-staffing-"));
    const handle = createDbFor(root);
    resources.push({ close: handle.close, root });
    runMigrations(handle);
    const commands = new CompanyCommandService(handle.db);
    await commands.execute({
      type: "setup_company",
      organizationId: "org_staffing",
      actorId: "founder",
      idempotencyKey: "setup",
      description: "A focused company",
      ceoAgentId: "agent/ceo",
      operatorAgentId: "agent/operator",
      policy: {
        provider: "opencode_cli",
        runtime: {
          kind: "docker",
          image: "aaspai-opencode-test:latest",
          network: "bridge",
        },
      },
      objectives: [{ title: "Generate demand", successCriteria: ["10 qualified leads"] }],
    });
    await commands.execute({
      type: "validate_company",
      organizationId: "org_staffing",
      actorId: "founder",
      idempotencyKey: "validate",
    });
    await commands.execute({
      type: "start_discovery",
      organizationId: "org_staffing",
      actorId: "founder",
      idempotencyKey: "discovery",
    });
    const goalId = (await commands.getSummary("org_staffing")).objectives[0]!.id;
    await commands.execute({
      type: "submit_portfolio_proposal",
      organizationId: "org_staffing",
      actorId: "agent/ceo",
      idempotencyKey: "proposal",
      summary: "Start with one growth project.",
      evidence: ["artifact/discovery"],
      projects: [
        {
          goalId,
          title: "Lead generation",
          description: "Build a qualified pipeline.",
          managerAgentId: null,
        },
      ],
    });
    await commands.execute({
      type: "activate_company",
      organizationId: "org_staffing",
      actorId: "founder",
      idempotencyKey: "activate",
      approved: true,
    });
    const rows = await handle.db
      .select()
      .from(wakeups)
      .where(eq(wakeups.organizationId, "org_staffing"));
    const staffing = rows.find((row) => row.triggerDetail === "activate_company");
    const staffingPayload = JSON.parse(staffing!.payloadJson) as Record<string, unknown>;
    expect(staffingPayload).toMatchObject({
      prompt: expect.stringContaining("Staff each unstaffed project"),
      runtime: {
        kind: "docker",
        image: "aaspai-opencode-test:latest",
        network: "bridge",
      },
      requiredCompanyActions: [
        {
          type: "hire_and_delegate",
          projectId: expect.stringMatching(/^project\//),
        },
      ],
    });
    const reviewNotification = rows.find(
      (row) => row.triggerDetail === "submit_portfolio_proposal",
    );
    expect(JSON.parse(reviewNotification!.payloadJson)).not.toHaveProperty("prompt");
  });

  it("binds a manager-owned process to assigned agents and durable work lineage", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaspai-company-process-"));
    const handle = createDbFor(root);
    resources.push({ close: handle.close, root });
    runMigrations(handle);
    const timestamp = new Date().toISOString();
    const organizationId = "org_process";
    await handle.db.insert(companyProfiles).values({
      organizationId,
      description: "A process-driven company",
      lifecycleStatus: "active",
      ceoAgentId: "agent/ceo",
      operatorAgentId: "agent/operator",
      policyJson: "{}",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const store = new ExecutionStore(handle.db);
    const goal = await store.createGoal({ organizationId, title: "Build pipeline" });
    const project = await store.createProject({
      organizationId,
      goalId: goal.id,
      title: "Lead generation",
    });
    await handle.db.insert(projectAssignments).values([
      {
        id: "assignment/process-manager",
        organizationId,
        projectId: project.id,
        agentId: "agent/growth-manager",
        role: "manager",
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: "assignment/process-specialist",
        organizationId,
        projectId: project.id,
        agentId: "agent/lead-specialist",
        role: "member",
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ]);
    const repository = await store.createRepository({
      organizationId,
      projectId: project.id,
      purpose: "project",
      provider: "local",
      localPath: "workspace/process",
    });
    const revision = await store.createDefinitionRevision({
      organizationId,
      repositoryId: repository.id,
      commitSha: "abcdef1",
      sourcePath: ".",
      contentHash: "process-definition",
    });
    const commands = new CompanyCommandService(handle.db);
    const milestone = await commands.execute({
      type: "create_milestone",
      organizationId,
      actorId: "agent/growth-manager",
      idempotencyKey: "process-milestone",
      projectId: project.id,
      title: "Qualify ten leads",
      sequence: 1,
      acceptance: { qualified: 10 },
    });
    const definition = {
      id: "process/lead-qualification",
      organizationId,
      revision: 1,
      contentHash: "lead-qualification-v1",
      name: "Lead qualification",
      description: "Qualify one bounded batch.",
      steps: [
        {
          id: "step/qualify",
          agent: "agent/lead-specialist",
          routingRule: null,
          dependsOn: [],
          prompt: "Qualify the current lead batch.",
          skills: [],
          tools: [],
          timeoutMs: 60_000,
          maxAttempts: 2,
          acceptanceCriteria: "A verified qualification report exists.",
          failureAction: "escalate" as const,
          approvalPolicy: {},
        },
      ],
      maxDurationMs: 300_000,
      maxAttempts: 3,
      createdAt: timestamp,
    };
    const managerDefinition = {
      ...definition,
      id: "process/manager-self-run",
      contentHash: "manager-self-run-v1",
      steps: definition.steps.map((step) => ({ ...step, agent: "agent/growth-manager" })),
    };
    await expect(
      commands.execute({
        type: "bind_process",
        organizationId,
        actorId: "agent/growth-manager",
        idempotencyKey: "manager-self-binding",
        projectId: project.id,
        processDefinitionId: managerDefinition.id,
        processRevision: managerDefinition.revision,
        definition: managerDefinition,
        ownerAgentId: "agent/growth-manager",
        policy: {},
      }),
    ).rejects.toThrow("process steps must be assigned to specialists");
    const unassignedDefinition = {
      ...definition,
      id: "process/unassigned",
      contentHash: "unassigned-v1",
      steps: definition.steps.map((step) => ({ ...step, agent: "agent/not-assigned" })),
    };
    await expect(
      commands.execute({
        type: "bind_process",
        organizationId,
        actorId: "agent/growth-manager",
        idempotencyKey: "unassigned-binding",
        projectId: project.id,
        processDefinitionId: unassignedDefinition.id,
        processRevision: unassignedDefinition.revision,
        definition: unassignedDefinition,
        ownerAgentId: "agent/growth-manager",
        policy: {},
      }),
    ).rejects.toThrow("agents not assigned to the project");
    expect(
      await handle.db
        .select()
        .from(processBindings)
        .where(eq(processBindings.organizationId, organizationId)),
    ).toHaveLength(0);
    const binding = await commands.execute({
      type: "bind_process",
      organizationId,
      actorId: "agent/growth-manager",
      idempotencyKey: "process-binding",
      projectId: project.id,
      processDefinitionId: definition.id,
      processRevision: definition.revision,
      definition,
      ownerAgentId: "agent/growth-manager",
      policy: {},
    });
    await commands.execute({
      type: "start_process_run",
      organizationId,
      actorId: "agent/growth-manager",
      idempotencyKey: "process-run",
      projectId: project.id,
      goalId: goal.id,
      milestoneId: milestone.id,
      repositoryId: repository.id,
      definitionRevisionId: revision.id,
      operatorAgentId: "agent/growth-manager",
      sourceCommitSha: "abcdef1",
      definition,
    });
    await expect(
      commands.execute({
        type: "start_process_run",
        organizationId,
        actorId: "agent/growth-manager",
        idempotencyKey: "duplicate-process-run",
        projectId: project.id,
        goalId: goal.id,
        milestoneId: milestone.id,
        repositoryId: repository.id,
        definitionRevisionId: revision.id,
        operatorAgentId: "agent/growth-manager",
        sourceCommitSha: "abcdef1",
        definition,
      }),
    ).rejects.toThrow("project already has active process work");
    const [workItem] = await handle.db
      .select()
      .from(executionWorkItems)
      .where(eq(executionWorkItems.processBindingId, binding.id!));
    expect(workItem).toMatchObject({
      goalId: goal.id,
      projectId: project.id,
      milestoneId: milestone.id,
      processBindingId: binding.id,
      assignedAgentId: "agent/lead-specialist",
      status: "ready",
    });
    expect(JSON.parse(workItem!.governanceJson)).toMatchObject({
      verification: { required: true, minEvidence: 1 },
    });
  });

  it("turns delivery evidence into reviewable improvements and wakes the company loop", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaspai-company-learning-"));
    const handle = createDbFor(root);
    resources.push({ close: handle.close, root });
    runMigrations(handle);
    const now = new Date().toISOString();
    await handle.db.insert(companyProfiles).values({
      organizationId: "org_learning",
      description: "",
      lifecycleStatus: "active",
      ceoAgentId: "agent/ceo",
      operatorAgentId: "agent/operator",
      policyJson: "{}",
      createdAt: now,
      updatedAt: now,
    });
    await handle.db.insert(goals).values({
      id: "goal_learning",
      organizationId: "org_learning",
      title: "Grow",
      successCriteriaJson: "[]",
      createdAt: now,
      updatedAt: now,
    });
    await handle.db.insert(projects).values({
      id: "project_learning",
      organizationId: "org_learning",
      goalId: "goal_learning",
      title: "Pipeline",
      healthStatus: "at_risk",
      createdAt: now,
      updatedAt: now,
    });
    await handle.db.insert(repositories).values({
      id: "repo_learning",
      organizationId: "org_learning",
      projectId: "project_learning",
      purpose: "project",
      provider: "local",
      localPath: "./workspace",
      createdAt: now,
      updatedAt: now,
    });
    await handle.db.insert(executionWorkItems).values({
      id: "work_learning",
      organizationId: "org_learning",
      goalId: "goal_learning",
      projectId: "project_learning",
      repositoryId: "repo_learning",
      title: "Reach customers",
      status: "blocked",
      blockedReason: "No owner",
      idempotencyKey: "work_learning",
      createdAt: now,
      updatedAt: now,
    });
    const learning = new ProcessImprovementService(handle.db);
    const evaluation = await learning.evaluate({
      organizationId: "org_learning",
      actorId: "agent/operator",
    });
    expect(evaluation.createdProposalIds.length).toBeGreaterThan(0);
    await learning.review({
      organizationId: "org_learning",
      proposalId: evaluation.createdProposalIds[0]!,
      action: "accept",
      actorId: "user/owner",
      reason: "Useful operating improvement",
    });
    expect(
      await handle.db.select().from(wakeups).where(eq(wakeups.organizationId, "org_learning")),
    ).toHaveLength(1);
  });

  it("round-trips strategic, execution, and knowledge state through a versioned full export", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "aaspai-company-export-source-"));
    const source = createDbFor(sourceRoot);
    resources.push({ close: source.close, root: sourceRoot });
    runMigrations(source);
    const commands = new CompanyCommandService(source.db);
    await commands.execute({
      type: "setup_company",
      organizationId: "org_export_full",
      actorId: "user/owner",
      idempotencyKey: "setup",
      ceoAgentId: "agent/ceo",
      objectives: [{ title: "Grow", successCriteria: ["customers"] }],
    });
    const bundle = await new CompanyFullExportService(source.db).exportCompany("org_export_full");
    expect(bundle.protocolVersion).toBe(2);
    expect(bundle.strategy.goals).toHaveLength(1);

    const targetRoot = await mkdtemp(join(tmpdir(), "aaspai-company-export-target-"));
    const target = createDbFor(targetRoot);
    resources.push({ close: target.close, root: targetRoot });
    runMigrations(target);
    await new CompanyFullExportService(target.db).importCompany("org_restored", bundle);
    expect(
      (await new StrategicReadModelService(target.db).getSummary("org_restored")).objectives,
    ).toHaveLength(1);
  });
});

function createDbFor(root: string) {
  process.env.AASPAI_DB = `sqlite:${join(root, "state.db")}`;
  return createDb();
}

async function seedVerifiedEvidence(
  db: ReturnType<typeof createDb>["db"],
  organizationId: string,
  goalId: string,
  projectId: string,
  milestoneId: string,
  evidenceIds: string[],
) {
  const store = new ExecutionStore(db);
  const repository = await store.createRepository({
    organizationId,
    projectId,
    purpose: "project",
    provider: "local",
    localPath: "workspace/evidence",
  });
  const revision = await store.createDefinitionRevision({
    organizationId,
    repositoryId: repository.id,
    commitSha: "abcdef1",
    sourcePath: ".",
    contentHash: "verified-evidence",
  });
  const workItem = await store.createWorkItem({
    organizationId,
    goalId,
    projectId,
    milestoneId,
    repositoryId: repository.id,
    title: "Verified company evidence",
    definitionRevisionId: revision.id,
    idempotencyKey: "verified-company-evidence",
    status: "completed",
  });
  const run = await store.createWorkflowRun({
    organizationId,
    goalId,
    definitionRevisionId: revision.id,
    idempotencyKey: "verified-company-evidence-run",
  });
  const attempt = await store.createAttempt({
    organizationId,
    workflowRunId: run.id,
    workItemId: workItem.id,
    agentId: "agent/checker",
    harness: "dry_run_local",
  });
  for (const [index, id] of evidenceIds.entries()) {
    await store.createArtifact({
      id,
      organizationId,
      attemptId: attempt.id,
      kind: "result",
      path: `evidence/${index}.json`,
      mediaType: "application/json",
      sizeBytes: 2,
      sha256: createHash("sha256").update(id).digest("hex"),
    });
  }
  const timestamp = new Date().toISOString();
  await db.insert(executionVerifications).values({
    id: "verification/company-rollup",
    organizationId,
    workItemId: workItem.id,
    makerAttemptId: attempt.id,
    status: "passed",
    summary: "Evidence independently verified.",
    evidenceIdsJson: JSON.stringify(evidenceIds),
    createdAt: timestamp,
    completedAt: timestamp,
  });
}
