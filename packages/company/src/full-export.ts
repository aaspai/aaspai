import {
  type CompanyFullExportBundle as Bundle,
  companyFullExportBundleSchema,
} from "@aaspai/contracts";
import {
  agentAttempts,
  artifacts,
  authorityEdges,
  autonomyChangeRequests,
  autonomyProposals,
  companyControlEvents,
  companyProfiles,
  definitionRevisions,
  delegations,
  departmentMembers,
  departments,
  eq,
  escalations,
  executionApprovals,
  executionBudgetReservations,
  executionControlDecisions,
  executionEscalations,
  executionEvents,
  executionExternalActions,
  executionGovernanceEvents,
  executionOperatorRuns,
  executionPlans,
  executionProcessDefinitions,
  executionRawOutputs,
  executionVerifications,
  executionWorkItemDependencies,
  executionWorkItems,
  executionWorkspaces,
  goals,
  inArray,
  knowledgeChangeRequests,
  knowledgeProposals,
  loopControls,
  loopOutputs,
  loops,
  memoryRecords,
  milestones,
  objectiveMeasurements,
  processBindings,
  projectAssignments,
  projectObjectives,
  projects,
  repositories,
  routingDecisions,
  type SqliteDb,
  serviceAgents,
  sessionEvents,
  sessions,
  temporalFacts,
  threadMessages,
  threads,
  wakeups,
  workflowRuns,
} from "@aaspai/db";

/** Safe, portable full-company restore. Target organizations must be empty. */
export class CompanyFullExportService {
  constructor(private readonly db: SqliteDb) {}

  async exportCompany(organizationId: string): Promise<Bundle> {
    const where = (table: object) =>
      this.db
        .select()
        .from(table as typeof goals)
        .where(eq((table as typeof goals).organizationId, organizationId));
    const [
      profiles,
      departmentRows,
      memberRows,
      serviceRows,
      authorityRows,
      routingRows,
      delegationRows,
      companyEscalationRows,
      autonomyRows,
      autonomyChangeRows,
      goalRows,
      projectRows,
      linkRows,
      measurementRows,
      assignmentRows,
      milestoneRows,
      bindingRows,
      threadRows,
      messageRows,
      eventRows,
      repositoryRows,
      revisionRows,
      processRows,
      workRows,
      dependencyRows,
      workflowRows,
      operatorRows,
      decisionRows,
      escalationRows,
      loopOutputRows,
      attemptRows,
      workspaceRows,
      planRows,
      artifactRows,
      eventRowsRaw,
      rawOutputRows,
      verificationRows,
      approvalRows,
      reservationRows,
      governanceRows,
      externalActionRows,
      loopRows,
      loopControlRows,
      wakeupRows,
      sessionRows,
      memoryRows,
      factRows,
      proposalRows,
      changeRows,
    ] = await Promise.all([
      where(companyProfiles),
      where(departments),
      where(departmentMembers),
      where(serviceAgents),
      where(authorityEdges),
      where(routingDecisions),
      where(delegations),
      where(escalations),
      where(autonomyProposals),
      where(autonomyChangeRequests),
      where(goals),
      where(projects),
      where(projectObjectives),
      where(objectiveMeasurements),
      where(projectAssignments),
      where(milestones),
      where(processBindings),
      where(threads),
      where(threadMessages),
      where(companyControlEvents),
      where(repositories),
      where(definitionRevisions),
      where(executionProcessDefinitions),
      where(executionWorkItems),
      where(executionWorkItemDependencies),
      where(workflowRuns),
      where(executionOperatorRuns),
      where(executionControlDecisions),
      where(executionEscalations),
      where(loopOutputs),
      where(agentAttempts),
      where(executionWorkspaces),
      where(executionPlans),
      where(artifacts),
      where(executionEvents),
      where(executionRawOutputs),
      where(executionVerifications),
      where(executionApprovals),
      where(executionBudgetReservations),
      where(executionGovernanceEvents),
      where(executionExternalActions),
      where(loops),
      where(loopControls),
      where(wakeups),
      where(sessions),
      where(memoryRecords),
      where(temporalFacts),
      where(knowledgeProposals),
      where(knowledgeChangeRequests),
    ]);
    const sessionIds = new Set(sessionRows.map((row) => String(row.id)));
    const sessionEventRows = sessionIds.size
      ? await this.db
          .select()
          .from(sessionEvents)
          .where(inArray(sessionEvents.sessionId, [...sessionIds]))
      : [];
    return companyFullExportBundleSchema.parse({
      kind: "aaspai.company",
      protocolVersion: 2,
      exportedAt: new Date().toISOString(),
      profile: profiles[0] ? portable(profiles[0]) : null,
      operations: {
        departments: departmentRows.map(portable),
        members: memberRows.map(portable),
        serviceAgents: serviceRows.map(portable),
        authorityEdges: authorityRows.map(portable),
        routingDecisions: routingRows.map(portable),
        delegations: delegationRows.map(portable),
        escalations: companyEscalationRows.map(portable),
        autonomyProposals: autonomyRows.map(portable),
        autonomyChangeRequests: autonomyChangeRows.map(portable),
      },
      strategy: {
        goals: goalRows.map(portable),
        projects: projectRows.map(portable),
        projectObjectives: linkRows.map(portable),
        measurements: measurementRows.map(portable),
        assignments: assignmentRows.map(portable),
        milestones: milestoneRows.map(portable),
        processBindings: bindingRows.map(portable),
        threads: threadRows.map(portable),
        threadMessages: messageRows.map(portable),
        controlEvents: eventRows.map(portable),
      },
      execution: {
        repositories: repositoryRows.map(portable),
        definitionRevisions: revisionRows.map(portable),
        processDefinitions: processRows.map(portable),
        workItems: workRows.map(portable),
        dependencies: dependencyRows.map(portable),
        workflowRuns: workflowRows.map(portable),
        operatorRuns: operatorRows.map(portable),
        controlDecisions: decisionRows.map(portable),
        escalations: escalationRows.map(portable),
        loopOutputs: loopOutputRows.map(portable),
        agentAttempts: attemptRows.map(portable),
        workspaces: workspaceRows.map(portable),
        plans: planRows.map(portable),
        artifacts: artifactRows.map(portable),
        events: eventRowsRaw.map(portable),
        rawOutputs: rawOutputRows.map(portable),
        verifications: verificationRows.map(portable),
        approvals: approvalRows.map(portable),
        budgetReservations: reservationRows.map(portable),
        governanceEvents: governanceRows.map(portable),
        externalActions: externalActionRows.map(portable),
        loops: loopRows.map(portable),
        loopControls: loopControlRows.map(portable),
        wakeups: wakeupRows.map(portable),
        sessions: sessionRows.map(portable),
        sessionEvents: sessionEventRows.map(({ id: _, ...row }) => row),
      },
      knowledge: {
        memories: memoryRows.map(portable),
        facts: factRows.map(portable),
        proposals: proposalRows.map(portable),
        changeRequests: changeRows.map(portable),
      },
    });
  }

  validateImport(input: unknown): Bundle {
    const bundle = companyFullExportBundleSchema.parse(input);
    const ids = new Set(bundle.strategy.goals.map((row) => String(row.id)));
    if (bundle.strategy.projects.some((row) => !ids.has(String(row.goalId))))
      throw new Error("full company bundle contains a project for a missing objective");
    const projectIds = new Set(bundle.strategy.projects.map((row) => String(row.id)));
    assertReferences(bundle.strategy.projectObjectives, "goalId", ids, "project objective");
    assertReferences(
      bundle.strategy.projectObjectives,
      "projectId",
      projectIds,
      "project objective",
    );
    assertReferences(bundle.strategy.assignments, "projectId", projectIds, "project assignment");
    assertReferences(bundle.strategy.milestones, "projectId", projectIds, "milestone");
    assertReferences(bundle.strategy.processBindings, "projectId", projectIds, "process binding");
    const milestoneIds = new Set(bundle.strategy.milestones.map((row) => String(row.id)));
    const bindingIds = new Set(bundle.strategy.processBindings.map((row) => String(row.id)));
    assertReferences(bundle.execution.repositories, "projectId", projectIds, "repository", true);
    const repositoryIds = new Set(bundle.execution.repositories.map((row) => String(row.id)));
    assertReferences(
      bundle.execution.definitionRevisions,
      "repositoryId",
      repositoryIds,
      "definition revision",
    );
    const revisionIds = new Set(bundle.execution.definitionRevisions.map((row) => String(row.id)));
    assertReferences(bundle.execution.workflowRuns, "goalId", ids, "workflow run");
    assertReferences(
      bundle.execution.workflowRuns,
      "definitionRevisionId",
      revisionIds,
      "workflow run",
    );
    assertReferences(bundle.execution.workItems, "goalId", ids, "work item");
    assertReferences(bundle.execution.workItems, "projectId", projectIds, "work item");
    assertReferences(bundle.execution.workItems, "repositoryId", repositoryIds, "work item");
    const workIds = new Set(bundle.execution.workItems.map((row) => String(row.id)));
    assertReferences(bundle.execution.workItems, "milestoneId", milestoneIds, "work item", true);
    assertReferences(bundle.execution.workItems, "processBindingId", bindingIds, "work item", true);
    assertReferences(bundle.execution.workItems, "parentWorkItemId", workIds, "work item", true);
    assertReferences(bundle.execution.dependencies, "workItemId", workIds, "work dependency");
    assertReferences(
      bundle.execution.dependencies,
      "dependsOnWorkItemId",
      workIds,
      "work dependency",
    );
    const workflowIds = new Set(bundle.execution.workflowRuns.map((row) => String(row.id)));
    assertReferences(bundle.execution.workItems, "workflowRunId", workflowIds, "work item", true);
    assertReferences(bundle.execution.agentAttempts, "workflowRunId", workflowIds, "agent attempt");
    assertReferences(bundle.execution.agentAttempts, "workItemId", workIds, "agent attempt");
    const attemptIds = new Set(bundle.execution.agentAttempts.map((row) => String(row.id)));
    assertReferences(bundle.execution.workspaces, "attemptId", attemptIds, "workspace");
    assertReferences(bundle.execution.workspaces, "repositoryId", repositoryIds, "workspace");
    assertReferences(bundle.execution.plans, "workItemId", workIds, "plan");
    assertReferences(bundle.execution.plans, "attemptId", attemptIds, "plan");
    assertReferences(bundle.execution.artifacts, "attemptId", attemptIds, "artifact");
    assertReferences(bundle.execution.events, "attemptId", attemptIds, "event");
    assertReferences(bundle.execution.rawOutputs, "attemptId", attemptIds, "raw output");
    assertReferences(bundle.execution.verifications, "workItemId", workIds, "verification");
    assertReferences(bundle.execution.verifications, "makerAttemptId", attemptIds, "verification");
    const verificationIds = new Set(bundle.execution.verifications.map((row) => String(row.id)));
    assertReferences(bundle.execution.approvals, "workItemId", workIds, "approval");
    assertReferences(
      bundle.execution.approvals,
      "verificationId",
      verificationIds,
      "approval",
      true,
    );
    assertReferences(
      bundle.execution.budgetReservations,
      "workItemId",
      workIds,
      "budget reservation",
    );
    assertReferences(
      bundle.execution.budgetReservations,
      "attemptId",
      attemptIds,
      "budget reservation",
    );
    const runIds = new Set(bundle.execution.operatorRuns.map((row) => String(row.id)));
    assertReferences(
      bundle.execution.controlDecisions,
      "operatorRunId",
      runIds,
      "control decision",
    );
    assertReferences(bundle.operations.delegations, "workItemId", workIds, "delegation", true);
    const loopIds = new Set(bundle.execution.loops.map((row) => String(row.id)));
    assertReferences(bundle.execution.loopControls, "loopId", loopIds, "loop control");
    assertReferences(bundle.execution.wakeups, "loopId", loopIds, "wakeup");
    const wakeupIds = new Set(bundle.execution.wakeups.map((row) => String(row.id)));
    assertReferences(bundle.execution.sessions, "wakeupId", wakeupIds, "session");
    const sessionIds = new Set(bundle.execution.sessions.map((row) => String(row.id)));
    assertReferences(bundle.execution.sessionEvents, "sessionId", sessionIds, "session event");
    const threadIds = new Set(bundle.strategy.threads.map((row) => String(row.id)));
    if (bundle.strategy.threadMessages.some((row) => !threadIds.has(String(row.threadId))))
      throw new Error("full company bundle contains a message for a missing thread");
    const proposalIds = new Set(bundle.knowledge.proposals.map((row) => String(row.id)));
    assertReferences(
      bundle.knowledge.changeRequests,
      "proposalId",
      proposalIds,
      "knowledge change request",
    );
    return bundle;
  }

  async importCompany(organizationId: string, input: unknown): Promise<Bundle> {
    const bundle = this.validateImport(input);
    const existing = await Promise.all([
      this.db
        .select({ id: companyProfiles.organizationId })
        .from(companyProfiles)
        .where(eq(companyProfiles.organizationId, organizationId))
        .limit(1),
      this.db
        .select({ id: goals.id })
        .from(goals)
        .where(eq(goals.organizationId, organizationId))
        .limit(1),
      this.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.organizationId, organizationId))
        .limit(1),
      this.db
        .select({ id: departments.id })
        .from(departments)
        .where(eq(departments.organizationId, organizationId))
        .limit(1),
      this.db
        .select({ id: memoryRecords.id })
        .from(memoryRecords)
        .where(eq(memoryRecords.organizationId, organizationId))
        .limit(1),
      this.db
        .select({ id: loops.id })
        .from(loops)
        .where(eq(loops.organizationId, organizationId))
        .limit(1),
      this.db
        .select({ id: authorityEdges.id })
        .from(authorityEdges)
        .where(eq(authorityEdges.organizationId, organizationId))
        .limit(1),
    ]);
    if (existing.some((rows) => rows.length > 0))
      throw new Error("full-company import requires an empty target organization");
    this.db.transaction((tx) => {
      if (bundle.profile) insert(tx, companyProfiles, [bundle.profile], organizationId);
      insert(tx, departments, bundle.operations.departments, organizationId);
      insert(tx, departmentMembers, bundle.operations.members, organizationId);
      insert(tx, serviceAgents, bundle.operations.serviceAgents, organizationId);
      insert(tx, authorityEdges, bundle.operations.authorityEdges, organizationId);
      insert(tx, routingDecisions, bundle.operations.routingDecisions, organizationId);
      insert(tx, delegations, bundle.operations.delegations, organizationId);
      insert(tx, escalations, bundle.operations.escalations, organizationId);
      insert(tx, autonomyProposals, bundle.operations.autonomyProposals, organizationId);
      insert(tx, autonomyChangeRequests, bundle.operations.autonomyChangeRequests, organizationId);
      insert(tx, goals, bundle.strategy.goals, organizationId);
      insert(tx, projects, bundle.strategy.projects, organizationId);
      insert(tx, projectObjectives, bundle.strategy.projectObjectives, organizationId);
      insert(tx, objectiveMeasurements, bundle.strategy.measurements, organizationId);
      insert(tx, projectAssignments, bundle.strategy.assignments, organizationId);
      insert(tx, milestones, bundle.strategy.milestones, organizationId);
      insert(tx, processBindings, bundle.strategy.processBindings, organizationId);
      insert(tx, threads, bundle.strategy.threads, organizationId);
      insert(tx, threadMessages, bundle.strategy.threadMessages, organizationId);
      insert(tx, companyControlEvents, bundle.strategy.controlEvents, organizationId);
      insert(tx, repositories, bundle.execution.repositories, organizationId);
      insert(tx, definitionRevisions, bundle.execution.definitionRevisions, organizationId);
      insert(tx, executionProcessDefinitions, bundle.execution.processDefinitions, organizationId);
      insert(tx, workflowRuns, bundle.execution.workflowRuns, organizationId);
      insert(tx, executionWorkItems, bundle.execution.workItems, organizationId);
      insert(tx, executionWorkItemDependencies, bundle.execution.dependencies, organizationId);
      insert(tx, executionOperatorRuns, bundle.execution.operatorRuns, organizationId);
      insert(tx, executionControlDecisions, bundle.execution.controlDecisions, organizationId);
      insert(tx, executionEscalations, bundle.execution.escalations, organizationId);
      insert(tx, loopOutputs, bundle.execution.loopOutputs, organizationId);
      insert(tx, agentAttempts, bundle.execution.agentAttempts, organizationId);
      insert(tx, executionWorkspaces, bundle.execution.workspaces, organizationId);
      insert(tx, executionPlans, bundle.execution.plans, organizationId);
      insert(tx, artifacts, bundle.execution.artifacts, organizationId);
      insert(tx, executionEvents, bundle.execution.events, organizationId);
      insert(tx, executionRawOutputs, bundle.execution.rawOutputs, organizationId);
      insert(tx, executionVerifications, bundle.execution.verifications, organizationId);
      insert(tx, executionApprovals, bundle.execution.approvals, organizationId);
      insert(tx, executionBudgetReservations, bundle.execution.budgetReservations, organizationId);
      insert(tx, executionGovernanceEvents, bundle.execution.governanceEvents, organizationId);
      insert(tx, executionExternalActions, bundle.execution.externalActions, organizationId);
      insert(tx, loops, bundle.execution.loops, organizationId);
      insert(tx, loopControls, bundle.execution.loopControls, organizationId);
      insert(tx, wakeups, bundle.execution.wakeups, organizationId);
      insert(tx, sessions, bundle.execution.sessions, organizationId);
      if (bundle.execution.sessionEvents.length)
        tx.insert(sessionEvents)
          .values(bundle.execution.sessionEvents as never)
          .run();
      insert(tx, memoryRecords, bundle.knowledge.memories, organizationId);
      insert(tx, temporalFacts, bundle.knowledge.facts, organizationId);
      insert(tx, knowledgeProposals, bundle.knowledge.proposals, organizationId);
      insert(tx, knowledgeChangeRequests, bundle.knowledge.changeRequests, organizationId);
    });
    return bundle;
  }
}

function portable<T extends { organizationId: string }>(row: T): Omit<T, "organizationId"> {
  const { organizationId: _, ...rest } = row;
  return rest;
}

function withOrg(row: Record<string, unknown>, organizationId: string) {
  return { ...row, organizationId };
}

function insert(
  tx: Pick<SqliteDb, "insert">,
  table: Parameters<SqliteDb["insert"]>[0],
  rows: Record<string, unknown>[],
  organizationId: string,
) {
  if (rows.length)
    tx.insert(table)
      .values(rows.map((row) => withOrg(row, organizationId)) as never)
      .run();
}

function assertReferences(
  rows: Record<string, unknown>[],
  key: string,
  ids: Set<string>,
  label: string,
  nullable = false,
) {
  if (rows.some((row) => row[key] !== null && row[key] !== undefined && !ids.has(String(row[key]))))
    throw new Error(`full company bundle contains a ${label} for a missing reference`);
  if (!nullable && rows.some((row) => row[key] === null || row[key] === undefined))
    throw new Error(`full company bundle contains a ${label} without ${key}`);
}
