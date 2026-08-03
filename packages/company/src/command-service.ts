import { createHash } from "node:crypto";
import {
  type CompanyCommand,
  type CompanyStrategicSummary,
  companyCommandSchema,
  companyProfileSchema,
  type ExecutionTarget,
  executionTargetSchema,
} from "@aaspai/contracts";
import {
  and,
  companyControlEvents,
  companyProfiles,
  desc,
  eq,
  executionProcessDefinitions,
  executionVerifications,
  executionWorkItems,
  goals,
  inArray,
  loops,
  milestones,
  objectiveMeasurements,
  processBindings,
  projectAssignments,
  projectObjectives,
  projects,
  type SqliteDb,
  serviceAgents,
  sql,
  threadMessages,
  threads,
  wakeups,
  workflowRuns,
} from "@aaspai/db";
import { ExecutionStore, OperatorService, OperatorStateStore } from "@aaspai/execution";
import { CompanyControlPlaneService } from "./control-plane.js";
import { StrategicReadModelService } from "./strategic.js";

type Tx = Parameters<SqliteDb["transaction"]>[0] extends (tx: infer T) => unknown ? T : never;
type CommandResult = {
  command: CompanyCommand["type"];
  id?: string;
  status?: string;
  summary?: CompanyStrategicSummary;
};

export class CompanyCommandError extends Error {}

function isCompanyObjective(id: string): boolean {
  return !id.startsWith("goal:loops:");
}

/** Canonical strategic mutation boundary. Every web/API/agent mutation should call this service. */
export class CompanyCommandService {
  private readonly readModel: StrategicReadModelService;

  constructor(private readonly db: SqliteDb) {
    this.readModel = new StrategicReadModelService(db);
  }

  async execute(input: unknown): Promise<CommandResult> {
    const command = companyCommandSchema.parse(input);
    switch (command.type) {
      case "setup_company":
        return this.setup(command);
      case "validate_company":
        return this.validate(command);
      case "start_discovery":
        return this.startDiscovery(command);
      case "submit_portfolio_proposal":
        return this.submitPortfolioProposal(command);
      case "activate_company":
        return this.activate(command);
      case "create_objective":
        return this.createObjective(command);
      case "create_project":
        return this.createProject(command);
      case "link_project_objective":
        return this.linkProjectObjective(command);
      case "appoint_project_manager":
        return this.appointManager(command);
      case "assign_agent_to_project":
        return this.assignAgent(command);
      case "create_milestone":
        return this.createMilestone(command);
      case "bind_process":
        return this.bindProcess(command);
      case "start_process_run":
        return this.startProcessRun(command);
      case "record_measurement":
        return this.recordMeasurement(command);
      case "record_milestone_evaluation":
        return this.recordMilestoneEvaluation(command);
      case "evaluate_project":
        return this.evaluateProject(command);
      case "evaluate_objective":
        return this.evaluateObjective(command);
      case "create_thread":
        return this.createThread(command);
      case "add_thread_message":
        return this.addThreadMessage(command);
      case "pause_scope":
      case "resume_scope":
        return this.transitionScope(command);
    }
  }

  async getSummary(organizationId: string): Promise<CompanyStrategicSummary> {
    return this.readModel.getSummary(organizationId);
  }

  async listThreads(organizationId: string, entityType?: string, entityId?: string) {
    const filters = [eq(threads.organizationId, organizationId)];
    if (entityType) filters.push(eq(threads.entityType, entityType));
    if (entityId) filters.push(eq(threads.entityId, entityId));
    return this.db
      .select()
      .from(threads)
      .where(and(...filters));
  }

  async listThreadMessages(organizationId: string, threadId: string) {
    return this.db
      .select()
      .from(threadMessages)
      .where(
        and(
          eq(threadMessages.organizationId, organizationId),
          eq(threadMessages.threadId, threadId),
        ),
      );
  }

  private async setup(
    command: Extract<CompanyCommand, { type: "setup_company" }>,
  ): Promise<CommandResult> {
    const existing = await this.profile(command.organizationId);
    if (existing && existing.lifecycleStatus !== "draft") {
      const [prior] = await this.db
        .select({ id: companyControlEvents.id })
        .from(companyControlEvents)
        .where(
          and(
            eq(companyControlEvents.organizationId, command.organizationId),
            eq(companyControlEvents.correlationId, command.idempotencyKey),
          ),
        )
        .limit(1);
      if (prior) return this.result(command, command.organizationId, existing.lifecycleStatus);
      throw new CompanyCommandError("active company setup cannot be overwritten");
    }
    const timestamp = now();
    this.db.transaction((tx) => {
      tx.insert(companyProfiles)
        .values({
          organizationId: command.organizationId,
          description: command.description,
          lifecycleStatus: "draft",
          ceoAgentId: command.ceoAgentId,
          operatorAgentId: command.operatorAgentId,
          timezone: command.timezone,
          policyJson: JSON.stringify(command.policy),
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .onConflictDoUpdate({
          target: companyProfiles.organizationId,
          set: {
            description: command.description,
            ceoAgentId: command.ceoAgentId,
            operatorAgentId: command.operatorAgentId,
            timezone: command.timezone,
            policyJson: JSON.stringify(command.policy),
            updatedAt: timestamp,
          },
        })
        .run();
      for (const objective of command.objectives) {
        const id = objective.id ?? stableId("goal", `${command.organizationId}:${objective.title}`);
        tx.insert(goals)
          .values({
            id,
            organizationId: command.organizationId,
            title: objective.title,
            description: objective.description,
            priority: objective.priority,
            successCriteriaJson: JSON.stringify(objective.successCriteria),
            horizon: objective.horizon,
            targetAt: objective.targetAt,
            reviewCadence: objective.reviewCadence,
            status: "planned",
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .onConflictDoNothing()
          .run();
      }
      this.audit(tx, command, "company_profile", command.organizationId, "setup_company");
    });
    return this.result(command, command.organizationId);
  }

  private async validate(
    command: Extract<CompanyCommand, { type: "validate_company" }>,
  ): Promise<CommandResult> {
    const profile = await this.profile(command.organizationId);
    if (!profile) throw new CompanyCommandError("company profile not found");
    const objectives = (
      await this.db.select().from(goals).where(eq(goals.organizationId, command.organizationId))
    ).filter((objective) => isCompanyObjective(objective.id));
    if (objectives.length === 0)
      throw new CompanyCommandError("at least one objective is required");
    if (!profile.ceoAgentId) throw new CompanyCommandError("CEO agent is required");
    const timestamp = now();
    this.db.transaction((tx) => {
      tx.update(companyProfiles)
        .set({ lifecycleStatus: "validated", updatedAt: timestamp })
        .where(eq(companyProfiles.organizationId, command.organizationId))
        .run();
      this.audit(tx, command, "company_profile", command.organizationId, "validate_company");
    });
    return this.result(command, command.organizationId, "validated");
  }

  private async activate(
    command: Extract<CompanyCommand, { type: "activate_company" }>,
  ): Promise<CommandResult> {
    if (command.actorId.startsWith("agent/"))
      throw new CompanyCommandError("founder approval must come from a human");
    if (!command.approved)
      throw new CompanyCommandError("founder approval is required to activate a portfolio");
    const profile = await this.profile(command.organizationId);
    if (profile?.lifecycleStatus !== "review")
      throw new CompanyCommandError("a reviewed portfolio proposal is required before activation");
    const proposals = await this.db
      .select()
      .from(companyControlEvents)
      .where(
        and(
          eq(companyControlEvents.organizationId, command.organizationId),
          eq(companyControlEvents.action, "portfolio_proposal"),
        ),
      )
      .orderBy(desc(companyControlEvents.occurredAt))
      .limit(1);
    const proposedProjects = portfolioProjects(proposals[0]?.metadataJson ?? "{}");
    for (const project of proposedProjects)
      await this.requireGoal(command.organizationId, project.goalId);
    if (
      typeof profile.policy.maxProjects === "number" &&
      proposedProjects.length > profile.policy.maxProjects
    )
      throw new CompanyCommandError(
        `portfolio project limit (${profile.policy.maxProjects}) exceeded`,
      );
    const activationProjects = proposedProjects.map((proposal) => ({
      ...proposal,
      id: stableId(
        "project",
        `${command.organizationId}:portfolio:${proposal.goalId}:${proposal.title}`,
      ),
    }));
    const provider =
      typeof profile.policy.provider === "string" ? profile.policy.provider : "dry_run_local";
    const runtime = companyRuntime(profile.policy, provider);
    const staffingPrompt = [
      "The founder approved the company portfolio. Staff each unstaffed project with the smallest useful team.",
      "For every unstaffed project, submit one typed hire_and_delegate action.",
      'In OpenCode call company_action. In Codex return one final AASPAI_COMPANY_ACTIONS={"actions":[...]} line.',
      'Set projectId to the exact project ID and projectRole to "manager".',
      "The delegated manager assignment must require the manager to create measurable milestones, define one minimal repeatable process, and start it with assigned specialists.",
      "Do not hire roles without immediate project work.",
      "",
      "Approved projects:",
      JSON.stringify(activationProjects, null, 2),
    ].join("\n");
    const timestamp = now();
    this.db.transaction((tx) => {
      tx.update(companyProfiles)
        .set({ lifecycleStatus: "active", updatedAt: timestamp })
        .where(eq(companyProfiles.organizationId, command.organizationId))
        .run();
      for (const proposal of activationProjects) {
        const id = proposal.id;
        tx.insert(projects)
          .values({
            id,
            organizationId: command.organizationId,
            goalId: proposal.goalId,
            title: proposal.title,
            description: proposal.description,
            managerAgentId: proposal.managerAgentId,
            status: proposal.managerAgentId ? "staffed" : "approved",
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .onConflictDoNothing()
          .run();
        tx.insert(projectObjectives)
          .values({
            id: stableId("project-objective", `${id}:${proposal.goalId}`),
            organizationId: command.organizationId,
            projectId: id,
            goalId: proposal.goalId,
            isPrimary: true,
            contributionJson: "{}",
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .onConflictDoNothing()
          .run();
        if (proposal.managerAgentId)
          this.insertManager(tx, command, id, proposal.managerAgentId, timestamp);
      }
      this.audit(tx, command, "company_profile", command.organizationId, "activate_company");
      const unstaffed = activationProjects.filter((project) => !project.managerAgentId);
      if (unstaffed.length > 0) {
        this.wake(tx, command, profile.ceoAgentId, "CEO staffing session requested", {
          prompt: staffingPrompt,
          adapter: provider,
          runtime,
          requiredCompanyActions: unstaffed.map((project) => ({
            type: "hire_and_delegate",
            projectId: project.id,
          })),
        });
      }
    });
    return this.result(command, command.organizationId, "active");
  }

  private async startDiscovery(
    command: Extract<CompanyCommand, { type: "start_discovery" }>,
  ): Promise<CommandResult> {
    const profile = await this.profile(command.organizationId);
    if (profile?.lifecycleStatus !== "validated")
      throw new CompanyCommandError("company must be validated before discovery");
    const objectives = (
      await this.db
        .select({
          id: goals.id,
          title: goals.title,
          description: goals.description,
          successCriteriaJson: goals.successCriteriaJson,
        })
        .from(goals)
        .where(eq(goals.organizationId, command.organizationId))
    ).filter((objective) => isCompanyObjective(objective.id));
    const provider =
      typeof profile.policy.provider === "string" ? profile.policy.provider : "dry_run_local";
    const runtime = companyRuntime(profile.policy, provider);
    const prompt = [
      "Run the company's first bounded CEO discovery.",
      "Study the objectives, propose the smallest useful project portfolio, and do not execute the projects.",
      "Every proposed project must reference one objective ID from the supplied list.",
      "Return exactly one final line using this format:",
      'AASPAI_PORTFOLIO_PROPOSAL={"summary":"evidence-based recommendation","projects":[{"goalId":"goal/...","title":"Project","description":"Outcome","managerAgentId":null}]}',
      "",
      "Company description:",
      profile.description,
      "",
      "Founder's immediate priority:",
      typeof profile.policy.firstPriority === "string"
        ? profile.policy.firstPriority
        : "No separate immediate priority supplied.",
      "",
      "Objectives:",
      JSON.stringify(objectives, null, 2),
    ].join("\n");
    const timestamp = now();
    this.db.transaction((tx) => {
      tx.update(companyProfiles)
        .set({ lifecycleStatus: "discovery", updatedAt: timestamp })
        .where(eq(companyProfiles.organizationId, command.organizationId))
        .run();
      this.audit(tx, command, "company_profile", command.organizationId, "start_discovery");
      this.wake(tx, command, profile.ceoAgentId, "CEO discovery requested", {
        discoveryArtifactId: stableId(
          "discovery",
          `${command.organizationId}:${command.idempotencyKey}`,
        ),
        prompt,
        adapter: provider,
        runtime,
      });
    });
    return this.result(command, command.organizationId, "discovery");
  }

  private async submitPortfolioProposal(
    command: Extract<CompanyCommand, { type: "submit_portfolio_proposal" }>,
  ): Promise<CommandResult> {
    const [prior] = await this.db
      .select({ id: companyControlEvents.id })
      .from(companyControlEvents)
      .where(
        and(
          eq(companyControlEvents.organizationId, command.organizationId),
          eq(companyControlEvents.action, "portfolio_proposal"),
          eq(companyControlEvents.correlationId, command.idempotencyKey),
        ),
      )
      .limit(1);
    if (prior) {
      const current = await this.profile(command.organizationId);
      return this.result(command, command.organizationId, current?.lifecycleStatus ?? "review");
    }
    const profile = await this.profile(command.organizationId);
    if (profile?.lifecycleStatus !== "discovery")
      throw new CompanyCommandError("company is not awaiting a discovery proposal");
    if (command.actorId.startsWith("agent/") && command.actorId !== profile.ceoAgentId)
      throw new CompanyCommandError("only the configured CEO may submit a portfolio proposal");
    for (const project of command.projects)
      await this.requireGoal(command.organizationId, project.goalId);
    const timestamp = now();
    this.db.transaction((tx) => {
      tx.update(companyProfiles)
        .set({ lifecycleStatus: "review", updatedAt: timestamp })
        .where(eq(companyProfiles.organizationId, command.organizationId))
        .run();
      tx.insert(companyControlEvents)
        .values({
          id: stableId("portfolio-proposal", `${command.organizationId}:${command.idempotencyKey}`),
          organizationId: command.organizationId,
          actorId: command.actorId,
          action: "portfolio_proposal",
          targetType: "company_profile",
          targetId: command.organizationId,
          correlationId: command.idempotencyKey,
          occurredAt: timestamp,
          metadataJson: JSON.stringify({
            summary: command.summary,
            evidence: command.evidence,
            projects: command.projects,
          }),
        })
        .onConflictDoNothing()
        .run();
      this.wake(tx, command, null, "Founder portfolio approval requested");
    });
    return this.result(command, command.organizationId, "review");
  }

  private async createObjective(
    command: Extract<CompanyCommand, { type: "create_objective" }>,
  ): Promise<CommandResult> {
    await this.requireCeoActor(command.organizationId, command.actorId);
    const id = stableId("goal", `${command.organizationId}:${command.idempotencyKey}`);
    const timestamp = now();
    this.db.transaction((tx) => {
      tx.insert(goals)
        .values({
          id,
          organizationId: command.organizationId,
          title: command.title,
          description: command.description,
          priority: command.priority,
          successCriteriaJson: JSON.stringify(command.successCriteria),
          horizon: command.horizon,
          targetAt: command.targetAt,
          reviewCadence: command.reviewCadence,
          status: "planned",
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .onConflictDoNothing()
        .run();
      this.audit(tx, command, "objective", id, "create_objective");
      this.wake(tx, command, null, `Objective created: ${command.title}`);
    });
    return this.result(command, id);
  }

  private async createProject(
    command: Extract<CompanyCommand, { type: "create_project" }>,
  ): Promise<CommandResult> {
    await this.requireCeoActor(command.organizationId, command.actorId);
    const profile = await this.profile(command.organizationId);
    if (profile?.lifecycleStatus !== "active")
      throw new CompanyCommandError(
        "an approved active portfolio is required before creating projects",
      );
    await this.requireGoal(command.organizationId, command.goalId);
    await this.requireProjectCapacity(command.organizationId, profile.policy);
    const id = stableId("project", `${command.organizationId}:${command.idempotencyKey}`);
    const timestamp = now();
    this.db.transaction((tx) => {
      tx.insert(projects)
        .values({
          id,
          organizationId: command.organizationId,
          goalId: command.goalId,
          title: command.title,
          description: command.description,
          managerAgentId: command.managerAgentId,
          status: command.status,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .onConflictDoNothing()
        .run();
      tx.insert(projectObjectives)
        .values({
          id: stableId("project-objective", `${id}:${command.goalId}`),
          organizationId: command.organizationId,
          projectId: id,
          goalId: command.goalId,
          isPrimary: true,
          contributionJson: "{}",
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .onConflictDoNothing()
        .run();
      if (command.managerAgentId)
        this.insertManager(tx, command, id, command.managerAgentId, timestamp);
      this.audit(tx, command, "project", id, "create_project");
      this.wake(tx, command, command.managerAgentId, `Project created: ${command.title}`);
    });
    return this.result(command, id);
  }

  private async linkProjectObjective(
    command: Extract<CompanyCommand, { type: "link_project_objective" }>,
  ): Promise<CommandResult> {
    await this.requireProjectActor(command.organizationId, command.projectId, command.actorId);
    await this.requireProject(command.organizationId, command.projectId);
    await this.requireGoal(command.organizationId, command.goalId);
    const id = stableId("project-objective", `${command.projectId}:${command.goalId}`);
    const timestamp = now();
    this.db.transaction((tx) => {
      if (command.isPrimary) {
        tx.update(projectObjectives)
          .set({ isPrimary: false, updatedAt: timestamp })
          .where(
            and(
              eq(projectObjectives.organizationId, command.organizationId),
              eq(projectObjectives.projectId, command.projectId),
            ),
          )
          .run();
      }
      tx.insert(projectObjectives)
        .values({
          id,
          organizationId: command.organizationId,
          projectId: command.projectId,
          goalId: command.goalId,
          isPrimary: command.isPrimary,
          contributionJson: JSON.stringify(command.contribution),
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .onConflictDoUpdate({
          target: projectObjectives.id,
          set: {
            isPrimary: command.isPrimary,
            contributionJson: JSON.stringify(command.contribution),
            updatedAt: timestamp,
          },
        })
        .run();
      this.audit(tx, command, "project_objective", id, "link_project_objective");
      this.wake(tx, command, null, "Project objective alignment changed");
    });
    return this.result(command, id);
  }

  private async appointManager(
    command: Extract<CompanyCommand, { type: "appoint_project_manager" }>,
  ): Promise<CommandResult> {
    await this.requireCeoActor(command.organizationId, command.actorId);
    await this.requireProject(command.organizationId, command.projectId);
    const timestamp = now();
    const id = stableId("project-assignment", `${command.projectId}:manager`);
    this.db.transaction((tx) => {
      tx.update(projectAssignments)
        .set({ status: "released", updatedAt: timestamp })
        .where(
          and(
            eq(projectAssignments.organizationId, command.organizationId),
            eq(projectAssignments.projectId, command.projectId),
            eq(projectAssignments.role, "manager"),
            eq(projectAssignments.status, "active"),
          ),
        )
        .run();
      this.insertManager(tx, command, command.projectId, command.agentId, timestamp, id);
      tx.update(projects)
        .set({ managerAgentId: command.agentId, status: "staffed", updatedAt: timestamp })
        .where(
          and(
            eq(projects.organizationId, command.organizationId),
            eq(projects.id, command.projectId),
          ),
        )
        .run();
      this.audit(tx, command, "project", command.projectId, "appoint_project_manager");
      this.wake(tx, command, command.agentId, "Project manager appointed");
    });
    return this.result(command, command.projectId, "staffed");
  }

  private async assignAgent(
    command: Extract<CompanyCommand, { type: "assign_agent_to_project" }>,
  ): Promise<CommandResult> {
    await this.requireProjectActor(command.organizationId, command.projectId, command.actorId);
    await this.requireProject(command.organizationId, command.projectId);
    await this.requireAgentCapacity(
      command.organizationId,
      command.projectId,
      command.agentId,
      command.role,
      command.allocationPercent,
    );
    const id = stableId(
      "project-assignment",
      `${command.projectId}:${command.agentId}:${command.role}`,
    );
    const timestamp = now();
    this.db.transaction((tx) => {
      tx.insert(projectAssignments)
        .values({
          id,
          organizationId: command.organizationId,
          projectId: command.projectId,
          agentId: command.agentId,
          role: command.role,
          allocationPercent: command.allocationPercent,
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .onConflictDoUpdate({
          target: projectAssignments.id,
          set: {
            allocationPercent: command.allocationPercent,
            status: "active",
            updatedAt: timestamp,
          },
        })
        .run();
      this.audit(tx, command, "project_assignment", id, "assign_agent_to_project");
    });
    return this.result(command, id, "active");
  }

  private async createMilestone(
    command: Extract<CompanyCommand, { type: "create_milestone" }>,
  ): Promise<CommandResult> {
    await this.requireProjectActor(command.organizationId, command.projectId, command.actorId);
    await this.requireProject(command.organizationId, command.projectId);
    const id = stableId("milestone", `${command.organizationId}:${command.idempotencyKey}`);
    const timestamp = now();
    this.db.transaction((tx) => {
      tx.insert(milestones)
        .values({
          id,
          organizationId: command.organizationId,
          projectId: command.projectId,
          title: command.title,
          outcome: command.outcome,
          ownerAgentId: command.ownerAgentId,
          sequence: command.sequence,
          status: "proposed",
          acceptanceJson: JSON.stringify(command.acceptance),
          targetAt: command.targetAt,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .onConflictDoNothing()
        .run();
      this.audit(tx, command, "milestone", id, "create_milestone");
      this.wake(tx, command, command.ownerAgentId, `Milestone created: ${command.title}`);
    });
    return this.result(command, id, "proposed");
  }

  private async bindProcess(
    command: Extract<CompanyCommand, { type: "bind_process" }>,
  ): Promise<CommandResult> {
    await this.requireProjectActor(command.organizationId, command.projectId, command.actorId);
    await this.requireProject(command.organizationId, command.projectId);
    await this.requireProjectManager(
      command.organizationId,
      command.projectId,
      command.ownerAgentId,
    );
    if (command.definition) {
      if (
        command.definition.organizationId !== command.organizationId ||
        command.definition.id !== command.processDefinitionId ||
        command.definition.revision !== command.processRevision
      ) {
        throw new CompanyCommandError("bound process definition identity does not match");
      }
      const assignedAgents = new Set(
        (
          await this.db
            .select({ agentId: projectAssignments.agentId })
            .from(projectAssignments)
            .where(
              and(
                eq(projectAssignments.organizationId, command.organizationId),
                eq(projectAssignments.projectId, command.projectId),
                eq(projectAssignments.status, "active"),
              ),
            )
        ).map((assignment) => assignment.agentId),
      );
      const unassigned = command.definition.steps
        .map((step) => step.agent)
        .filter((agentId): agentId is string => agentId !== null)
        .filter((agentId) => !assignedAgents.has(agentId));
      if (unassigned.length > 0)
        throw new CompanyCommandError(
          `process references agents not assigned to the project: ${[...new Set(unassigned)].join(", ")}`,
        );
      const managerSteps = command.definition.steps
        .filter((step) => step.agent === command.ownerAgentId)
        .map((step) => step.id);
      if (managerSteps.length > 0)
        throw new CompanyCommandError(
          `process steps must be assigned to specialists, not the project manager: ${managerSteps.join(", ")}`,
        );
      await new OperatorStateStore(this.db).saveProcessDefinition(command.definition);
    }
    const definitions = await this.db
      .select({ id: executionProcessDefinitions.id })
      .from(executionProcessDefinitions)
      .where(
        and(
          eq(executionProcessDefinitions.organizationId, command.organizationId),
          eq(executionProcessDefinitions.id, command.processDefinitionId),
          eq(executionProcessDefinitions.revision, command.processRevision),
        ),
      )
      .limit(1);
    if (!definitions[0]) throw new CompanyCommandError("process definition revision not found");
    const activeBindings = await this.db
      .select()
      .from(processBindings)
      .where(
        and(
          eq(processBindings.organizationId, command.organizationId),
          eq(processBindings.projectId, command.projectId),
          eq(processBindings.ownerAgentId, command.ownerAgentId),
          eq(processBindings.status, "active"),
        ),
      );
    const existing = activeBindings.find(
      (binding) =>
        binding.processDefinitionId === command.processDefinitionId ||
        (command.loopId !== null && binding.loopId === command.loopId),
    );
    const id =
      existing?.id ??
      stableId("process-binding", `${command.organizationId}:${command.idempotencyKey}`);
    const timestamp = now();
    this.db.transaction((tx) => {
      if (existing) {
        tx.update(processBindings)
          .set({
            processDefinitionId: command.processDefinitionId,
            processRevision: command.processRevision,
            loopId: command.loopId,
            policyJson: JSON.stringify(command.policy),
            updatedAt: timestamp,
          })
          .where(eq(processBindings.id, existing.id))
          .run();
      } else {
        tx.insert(processBindings)
          .values({
            id,
            organizationId: command.organizationId,
            projectId: command.projectId,
            processDefinitionId: command.processDefinitionId,
            processRevision: command.processRevision,
            ownerAgentId: command.ownerAgentId,
            loopId: command.loopId,
            status: "active",
            performanceJson: "{}",
            policyJson: JSON.stringify(command.policy),
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .run();
      }
      this.audit(tx, command, "process_binding", id, "bind_process");
      this.wake(tx, command, command.ownerAgentId, "Process binding activated");
    });
    return this.result(command, id, "active");
  }

  private async startProcessRun(
    command: Extract<CompanyCommand, { type: "start_process_run" }>,
  ): Promise<CommandResult> {
    await this.requireProjectActor(command.organizationId, command.projectId, command.actorId);
    const bindings = await this.db
      .select()
      .from(processBindings)
      .where(
        and(
          eq(processBindings.organizationId, command.organizationId),
          eq(processBindings.projectId, command.projectId),
          eq(processBindings.processDefinitionId, command.definition.id),
          eq(processBindings.processRevision, command.definition.revision),
          eq(processBindings.status, "active"),
        ),
      );
    const binding = bindings[0];
    if (!binding) throw new CompanyCommandError("active process binding not found");
    const [activeProcessWork] = await this.db
      .select({
        id: executionWorkItems.id,
        processBindingId: executionWorkItems.processBindingId,
        runIdempotencyKey: workflowRuns.idempotencyKey,
      })
      .from(executionWorkItems)
      .innerJoin(workflowRuns, eq(workflowRuns.id, executionWorkItems.workflowRunId))
      .where(
        and(
          eq(executionWorkItems.organizationId, command.organizationId),
          eq(executionWorkItems.projectId, command.projectId),
          sql`${executionWorkItems.processBindingId} is not null`,
          inArray(executionWorkItems.status, [
            "proposed",
            "ready",
            "claimed",
            "in_progress",
            "awaiting_verification",
            "awaiting_approval",
            "blocked",
          ]),
        ),
      )
      .limit(1);
    if (
      activeProcessWork &&
      (activeProcessWork.processBindingId !== binding.id ||
        activeProcessWork.runIdempotencyKey !== command.idempotencyKey)
    ) {
      throw new CompanyCommandError(
        `project already has active process work ${activeProcessWork.id}`,
      );
    }
    const [project] = await this.db
      .select({ status: projects.status, goalId: projects.goalId })
      .from(projects)
      .where(
        and(
          eq(projects.organizationId, command.organizationId),
          eq(projects.id, command.projectId),
        ),
      )
      .limit(1);
    if (!project || ["paused", "completed", "cancelled", "archived"].includes(project.status))
      throw new CompanyCommandError("project is not available for a process run");
    if (project.goalId !== command.goalId)
      throw new CompanyCommandError("process run goal is not aligned to its project");
    if (command.definition.organizationId !== command.organizationId)
      throw new CompanyCommandError("process definition belongs to another organization");
    if (command.operatorAgentId !== binding.ownerAgentId)
      throw new CompanyCommandError("process run must be owned by the bound project manager");
    const [assignments, availableAgents] = await Promise.all([
      this.db
        .select({ agentId: projectAssignments.agentId, role: projectAssignments.role })
        .from(projectAssignments)
        .where(
          and(
            eq(projectAssignments.organizationId, command.organizationId),
            eq(projectAssignments.projectId, command.projectId),
            eq(projectAssignments.status, "active"),
          ),
        ),
      this.db
        .select()
        .from(serviceAgents)
        .where(
          and(
            eq(serviceAgents.organizationId, command.organizationId),
            eq(serviceAgents.status, "active"),
          ),
        ),
    ]);
    const assignedAgents = new Set(assignments.map((row) => row.agentId));
    const unassigned = command.definition.steps
      .map((step) => step.agent)
      .filter((agentId): agentId is string => agentId !== null)
      .filter((agentId) => !assignedAgents.has(agentId));
    if (unassigned.length > 0)
      throw new CompanyCommandError(
        `process references agents not assigned to the project: ${[...new Set(unassigned)].join(", ")}`,
      );
    const managerSteps = command.definition.steps
      .filter((step) => step.agent === binding.ownerAgentId)
      .map((step) => step.id);
    if (managerSteps.length > 0)
      throw new CompanyCommandError(
        `process steps must be assigned to specialists, not the project manager: ${managerSteps.join(", ")}`,
      );
    const routedAgents = new Map<string, string>();
    const control = new CompanyControlPlaneService(this.db);
    for (const step of command.definition.steps.filter((item) => item.agent === null)) {
      const rule = step.routingRule;
      if (!rule) throw new CompanyCommandError(`process step ${step.id} has no routing rule`);
      const candidate = availableAgents
        .filter((agent) => assignedAgents.has(agent.agentId))
        .filter((agent) => agent.agentId !== binding.ownerAgentId)
        .filter((agent) => !rule.departmentId || agent.departmentId === rule.departmentId)
        .filter((agent) => {
          const assignment = assignments.find((row) => row.agentId === agent.agentId);
          const metadata = parseObject(agent.metadataJson);
          const roles = parseStringArrayValue(metadata.roles);
          const capabilities = parseStringArrayValue(metadata.capabilities);
          return (
            (!rule.role || assignment?.role === rule.role || roles.includes(rule.role)) &&
            rule.capabilities.every((capability) => capabilities.includes(capability))
          );
        })
        .sort((a, b) => a.failureCount - b.failureCount || a.agentId.localeCompare(b.agentId))[0];
      if (!candidate)
        throw new CompanyCommandError(`no assigned agent satisfies process step ${step.id}`);
      const decision = await control.route({
        organizationId: command.organizationId,
        idempotencyKey: `${command.idempotencyKey}:route:${step.id}`,
        requestedByAgentId: binding.ownerAgentId,
        targetAgentId: candidate.agentId,
        departmentId: rule.departmentId,
        requiredRole: rule.role,
        capability: rule.capabilities[0] ?? null,
        risk: "low",
        priority: 50,
        title: step.id,
        description: step.prompt || step.acceptanceCriteria,
      });
      if (decision.status !== "routed" || !decision.selectedAgentId)
        throw new CompanyCommandError(decision.reason);
      routedAgents.set(step.id, decision.selectedAgentId);
    }
    const started = await new OperatorService(new ExecutionStore(this.db)).startProcess({
      context: {
        organizationId: command.organizationId,
        actorId: command.actorId,
        correlationId: command.idempotencyKey,
      },
      operatorAgentId: binding.ownerAgentId,
      scopeType: "project",
      scopeId: command.projectId,
      processBindingId: binding.id,
      definition: command.definition,
      goalId: command.goalId,
      projectId: command.projectId,
      milestoneId: command.milestoneId,
      repositoryId: command.repositoryId,
      definitionRevisionId: command.definitionRevisionId,
      sourceCommitSha: command.sourceCommitSha,
      idempotencyKey: command.idempotencyKey,
      parentWorkItemId: command.parentWorkItemId,
      parentAttemptId: command.parentAttemptId,
      parentSessionId: command.parentSessionId,
      resolveAgent: async (step) => {
        const agentId = routedAgents.get(step.id);
        if (!agentId) throw new CompanyCommandError(`process step ${step.id} was not routed`);
        return agentId;
      },
    });
    const timestamp = now();
    await this.db
      .update(processBindings)
      .set({
        status: "active",
        performanceJson: JSON.stringify({
          ...parseObject(bindings[0]?.performanceJson ?? "{}"),
          runsStarted:
            Number(parseObject(bindings[0]?.performanceJson ?? "{}").runsStarted ?? 0) + 1,
          lastStartedAt: timestamp,
        }),
        updatedAt: timestamp,
      })
      .where(
        and(
          eq(processBindings.organizationId, command.organizationId),
          eq(processBindings.projectId, command.projectId),
          eq(processBindings.processDefinitionId, command.definition.id),
          eq(processBindings.processRevision, command.definition.revision),
        ),
      )
      .run();
    this.db.transaction((tx) => {
      tx.update(projects)
        .set({ status: "active", healthStatus: "healthy", updatedAt: timestamp })
        .where(
          and(
            eq(projects.organizationId, command.organizationId),
            eq(projects.id, command.projectId),
          ),
        )
        .run();
      this.audit(tx, command, "workflow_run", started.workflowRunId, "start_process_run");
      this.wake(tx, command, command.operatorAgentId, "Process run started", {
        operatorRunId: started.run.id,
        workflowRunId: started.workflowRunId,
      });
    });
    return {
      ...(await this.result(command, started.workflowRunId)),
      id: started.run.id,
      status: "running",
    };
  }

  private async recordMeasurement(
    command: Extract<CompanyCommand, { type: "record_measurement" }>,
  ): Promise<CommandResult> {
    await this.requireGoal(command.organizationId, command.goalId);
    if (command.sourceType !== "human") {
      if (!command.sourceId || command.evidence.length === 0)
        throw new CompanyCommandError("non-human measurements require a source and evidence");
      await this.requireVerifiedEvidence(command.organizationId, command.evidence, {
        goalId: command.goalId,
      });
    } else if (command.actorId.startsWith("agent/")) {
      throw new CompanyCommandError("human measurements must be recorded by a human");
    }
    const id = stableId("measurement", `${command.organizationId}:${command.idempotencyKey}`);
    const timestamp = now();
    this.db.transaction((tx) => {
      tx.insert(objectiveMeasurements)
        .values({
          id,
          organizationId: command.organizationId,
          goalId: command.goalId,
          metricKey: command.metricKey,
          valueJson: JSON.stringify(command.value),
          unit: command.unit,
          observedAt: command.observedAt,
          sourceType: command.sourceType,
          sourceId: command.sourceId,
          evidenceJson: JSON.stringify(command.evidence),
          recordedBy: command.actorId,
          createdAt: timestamp,
        })
        .onConflictDoNothing()
        .run();
      this.audit(tx, command, "objective_measurement", id, "record_measurement");
      this.wake(tx, command, null, `Measurement recorded: ${command.metricKey}`);
    });
    return this.result(command, id);
  }

  private async createThread(
    command: Extract<CompanyCommand, { type: "create_thread" }>,
  ): Promise<CommandResult> {
    const id = stableId("thread", `${command.organizationId}:${command.idempotencyKey}`);
    const timestamp = now();
    this.db.transaction((tx) => {
      tx.insert(threads)
        .values({
          id,
          organizationId: command.organizationId,
          entityType: command.entityType,
          entityId: command.entityId,
          title: command.title,
          createdBy: command.actorId,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .onConflictDoNothing()
        .run();
      this.audit(tx, command, "thread", id, "create_thread");
    });
    return this.result(command, id);
  }

  private async recordMilestoneEvaluation(
    command: Extract<CompanyCommand, { type: "record_milestone_evaluation" }>,
  ): Promise<CommandResult> {
    await this.requireProjectActor(command.organizationId, command.projectId, command.actorId);
    const rows = await this.db
      .select()
      .from(milestones)
      .where(
        and(
          eq(milestones.organizationId, command.organizationId),
          eq(milestones.projectId, command.projectId),
          eq(milestones.id, command.milestoneId),
        ),
      )
      .limit(1);
    const milestone = rows[0];
    if (!milestone) throw new CompanyCommandError("milestone not found");
    if (command.status === "accepted")
      await this.requireVerifiedEvidence(command.organizationId, command.evidence, {
        milestoneId: command.milestoneId,
      });
    const timestamp = now();
    this.db.transaction((tx) => {
      tx.update(milestones)
        .set({
          status: command.status,
          acceptanceJson: JSON.stringify({
            ...parseObject(milestone.acceptanceJson),
            evidence: command.evidence,
            rationale: command.rationale,
            evaluatedAt: timestamp,
          }),
          updatedAt: timestamp,
        })
        .where(eq(milestones.id, command.milestoneId))
        .run();
      if (command.status !== "accepted") {
        tx.update(projects)
          .set({ healthStatus: "at_risk", updatedAt: timestamp })
          .where(eq(projects.id, command.projectId))
          .run();
      }
      this.audit(tx, command, "milestone", command.milestoneId, command.type);
      this.wake(
        tx,
        command,
        milestone.ownerAgentId,
        `Milestone ${command.status}: ${milestone.title}`,
      );
    });
    return this.result(command, command.milestoneId, command.status);
  }

  private async evaluateProject(
    command: Extract<CompanyCommand, { type: "evaluate_project" }>,
  ): Promise<CommandResult> {
    await this.requireProjectActor(command.organizationId, command.projectId, command.actorId);
    await this.requireProject(command.organizationId, command.projectId);
    await this.requireVerifiedEvidence(command.organizationId, command.evidence, {
      projectId: command.projectId,
    });
    const [projectRows, milestoneRows, milestoneWork] = await Promise.all([
      this.db
        .select({ managerAgentId: projects.managerAgentId, status: projects.status })
        .from(projects)
        .where(
          and(
            eq(projects.organizationId, command.organizationId),
            eq(projects.id, command.projectId),
          ),
        )
        .limit(1),
      this.db
        .select()
        .from(milestones)
        .where(
          and(
            eq(milestones.organizationId, command.organizationId),
            eq(milestones.projectId, command.projectId),
          ),
        ),
      this.db
        .select({ status: executionWorkItems.status, milestoneId: executionWorkItems.milestoneId })
        .from(executionWorkItems)
        .where(
          and(
            eq(executionWorkItems.organizationId, command.organizationId),
            eq(executionWorkItems.projectId, command.projectId),
          ),
        ),
    ]);
    const project = projectRows[0];
    const complete =
      milestoneRows.length > 0 &&
      milestoneRows.every((row) => row.status === "accepted") &&
      milestoneWork
        .filter((item) => item.milestoneId !== null)
        .every((item) => item.status === "completed");
    const timestamp = now();
    this.db.transaction((tx) => {
      tx.update(projects)
        .set({
          status: complete ? "completed" : (project?.status ?? "active"),
          healthStatus: complete ? "healthy" : "at_risk",
          updatedAt: timestamp,
        })
        .where(eq(projects.id, command.projectId))
        .run();
      this.audit(tx, command, "project", command.projectId, command.type);
      this.wake(
        tx,
        command,
        project?.managerAgentId ?? null,
        complete ? "Project accepted" : "Project remains incomplete: milestones need acceptance",
      );
    });
    return this.result(command, command.projectId, complete ? "completed" : "at_risk");
  }

  private async evaluateObjective(
    command: Extract<CompanyCommand, { type: "evaluate_objective" }>,
  ): Promise<CommandResult> {
    await this.requireCeoActor(command.organizationId, command.actorId);
    const profile = await this.profile(command.organizationId);
    await this.requireGoal(command.organizationId, command.goalId);
    await this.requireVerifiedEvidence(command.organizationId, command.evidence, {
      goalId: command.goalId,
    });
    const [links, measurements] = await Promise.all([
      this.db
        .select({ projectId: projectObjectives.projectId })
        .from(projectObjectives)
        .where(
          and(
            eq(projectObjectives.organizationId, command.organizationId),
            eq(projectObjectives.goalId, command.goalId),
          ),
        ),
      this.db
        .select({ id: objectiveMeasurements.id })
        .from(objectiveMeasurements)
        .where(
          and(
            eq(objectiveMeasurements.organizationId, command.organizationId),
            eq(objectiveMeasurements.goalId, command.goalId),
          ),
        )
        .limit(1),
    ]);
    const projectIds = links.map((link) => link.projectId);
    const projectRows = projectIds.length
      ? await this.db
          .select({ id: projects.id, status: projects.status })
          .from(projects)
          .where(eq(projects.organizationId, command.organizationId))
      : [];
    const complete =
      projectIds.length > 0 &&
      measurements.length > 0 &&
      projectIds.every((id) =>
        projectRows.some((project) => project.id === id && project.status === "completed"),
      );
    const timestamp = now();
    this.db.transaction((tx) => {
      tx.update(goals)
        .set({ status: complete ? "completed" : "active", updatedAt: timestamp })
        .where(eq(goals.id, command.goalId))
        .run();
      this.audit(tx, command, "objective", command.goalId, command.type);
      this.wake(
        tx,
        command,
        profile?.ceoAgentId ?? null,
        complete ? "Objective accepted" : "Objective needs evidence or completed projects",
      );
    });
    return this.result(command, command.goalId, complete ? "completed" : "active");
  }

  private async addThreadMessage(
    command: Extract<CompanyCommand, { type: "add_thread_message" }>,
  ): Promise<CommandResult> {
    const thread = await this.db
      .select()
      .from(threads)
      .where(
        and(eq(threads.organizationId, command.organizationId), eq(threads.id, command.threadId)),
      )
      .limit(1);
    if (!thread[0]) throw new CompanyCommandError("thread not found");
    const id = stableId("message", `${command.organizationId}:${command.idempotencyKey}`);
    const timestamp = now();
    this.db.transaction((tx) => {
      tx.insert(threadMessages)
        .values({
          id,
          organizationId: command.organizationId,
          threadId: command.threadId,
          authorId: command.actorId,
          body: command.body,
          metadataJson: JSON.stringify(command.metadata),
          createdAt: timestamp,
        })
        .onConflictDoNothing()
        .run();
      tx.update(threads)
        .set({ updatedAt: timestamp })
        .where(eq(threads.id, command.threadId))
        .run();
      this.audit(tx, command, "thread", command.threadId, "add_thread_message");
      this.wake(
        tx,
        command,
        mentionedAgent(command.body),
        `Thread message on ${thread[0]?.entityType ?? "entity"}/${thread[0]?.entityId ?? "unknown"}`,
      );
    });
    return this.result(command, id);
  }

  private async transitionScope(
    command: Extract<CompanyCommand, { type: "pause_scope" | "resume_scope" }>,
  ): Promise<CommandResult> {
    const status = command.type === "pause_scope" ? "paused" : "active";
    const timestamp = now();
    this.db.transaction((tx) => {
      if (command.scopeType === "company") {
        tx.update(companyProfiles)
          .set({ lifecycleStatus: status === "paused" ? "paused" : "active", updatedAt: timestamp })
          .where(eq(companyProfiles.organizationId, command.organizationId))
          .run();
      } else {
        tx.update(projects)
          .set({ status: status === "paused" ? "blocked" : "active", updatedAt: timestamp })
          .where(
            and(
              eq(projects.organizationId, command.organizationId),
              eq(projects.id, command.scopeId),
            ),
          )
          .run();
      }
      this.audit(tx, command, command.scopeType, command.scopeId, command.type);
      this.wake(tx, command, null, command.reason || `${command.scopeType} ${status}`);
    });
    return this.result(command, command.scopeId, status);
  }

  private insertManager(
    tx: Tx,
    command: CompanyCommand,
    projectId: string,
    agentId: string,
    timestamp: string,
    id = stableId("project-assignment", `${projectId}:manager`),
  ) {
    tx.insert(projectAssignments)
      .values({
        id,
        organizationId: command.organizationId,
        projectId,
        agentId,
        role: "manager",
        allocationPercent: 100,
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: projectAssignments.id,
        set: { agentId, status: "active", updatedAt: timestamp },
      })
      .run();
  }

  private audit(
    tx: Tx,
    command: CompanyCommand,
    targetType: string,
    targetId: string,
    action: string,
  ) {
    tx.insert(companyControlEvents)
      .values({
        id: stableId("audit", `${command.organizationId}:${command.idempotencyKey}`),
        organizationId: command.organizationId,
        actorId: command.actorId,
        action,
        targetType,
        targetId,
        correlationId: command.idempotencyKey,
        occurredAt: now(),
        metadataJson: JSON.stringify({ command: command.type }),
      })
      .onConflictDoNothing()
      .run();
  }

  private wake(
    tx: Tx,
    command: CompanyCommand,
    agentId: string | null,
    reason: string,
    payload: Record<string, unknown> = {},
  ) {
    const loopId = `loop/company-control/${safe(command.organizationId)}`;
    const timestamp = now();
    tx.insert(loops)
      .values({
        id: loopId,
        organizationId: command.organizationId,
        patternId: "company-control",
        configJson: "{}",
        gateJson: "{}",
        budgetJson: "{}",
        scheduleJson: "{}",
        paused: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoNothing()
      .run();
    tx.insert(wakeups)
      .values({
        id: stableId("wakeup", `${command.organizationId}:${command.idempotencyKey}`),
        organizationId: command.organizationId,
        loopId,
        source: "on_demand",
        triggerDetail: command.type,
        reason,
        agentId,
        payloadJson: JSON.stringify({
          command: command.type,
          operatorAgentId: agentId,
          ...payload,
        }),
        status: "queued",
        idempotencyKey: `control:${command.organizationId}:${command.idempotencyKey}`,
        requestedAt: timestamp,
        requestedByActorId: command.actorId,
        requestedByActorType: command.actorId.startsWith("agent/") ? "agent" : "user",
      })
      .onConflictDoNothing()
      .run();
  }

  private async profile(organizationId: string) {
    const rows = await this.db
      .select()
      .from(companyProfiles)
      .where(eq(companyProfiles.organizationId, organizationId))
      .limit(1);
    if (!rows[0]) return null;
    const { policyJson, ...profile } = rows[0];
    return companyProfileSchema.parse({ ...profile, policy: parseObject(policyJson) });
  }

  private async requireGoal(organizationId: string, id: string) {
    if (!isCompanyObjective(id)) throw new CompanyCommandError("objective not found");
    const rows = await this.db
      .select({ id: goals.id })
      .from(goals)
      .where(and(eq(goals.organizationId, organizationId), eq(goals.id, id)))
      .limit(1);
    if (!rows[0]) throw new CompanyCommandError("objective not found");
  }

  private async requireProject(organizationId: string, id: string) {
    const rows = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.organizationId, organizationId), eq(projects.id, id)))
      .limit(1);
    if (!rows[0]) throw new CompanyCommandError("project not found");
  }

  private async requireProjectCapacity(organizationId: string, policy: Record<string, unknown>) {
    const limit =
      typeof policy.maxProjects === "number" && policy.maxProjects >= 0
        ? Math.floor(policy.maxProjects)
        : null;
    if (limit === null) return;
    const active = await this.db
      .select({ status: projects.status })
      .from(projects)
      .where(eq(projects.organizationId, organizationId));
    if (
      active.filter((project) => !["completed", "cancelled"].includes(project.status)).length >=
      limit
    )
      throw new CompanyCommandError(`portfolio project limit (${limit}) reached`);
  }

  private async requireAgentCapacity(
    organizationId: string,
    projectId: string,
    agentId: string,
    role: string,
    allocationPercent: number,
  ) {
    const rows = await this.db
      .select()
      .from(projectAssignments)
      .where(
        and(
          eq(projectAssignments.organizationId, organizationId),
          eq(projectAssignments.agentId, agentId),
          eq(projectAssignments.status, "active"),
        ),
      );
    const current = rows.find((row) => row.projectId === projectId && row.role === role);
    const allocated = rows.reduce(
      (total, row) => total + (row.id === current?.id ? 0 : row.allocationPercent),
      0,
    );
    if (allocated + allocationPercent > 100)
      throw new CompanyCommandError(
        `agent allocation would exceed 100% (${allocated + allocationPercent}%)`,
      );
  }

  private async requireProjectActor(organizationId: string, projectId: string, actorId: string) {
    if (!actorId.startsWith("agent/")) return;
    const profile = await this.profile(organizationId);
    if (actorId === profile?.ceoAgentId) return;
    await this.requireProjectManager(organizationId, projectId, actorId);
  }

  private async requireProjectManager(organizationId: string, projectId: string, actorId: string) {
    const rows = await this.db
      .select({ agentId: projectAssignments.agentId })
      .from(projectAssignments)
      .where(
        and(
          eq(projectAssignments.organizationId, organizationId),
          eq(projectAssignments.projectId, projectId),
          eq(projectAssignments.agentId, actorId),
          eq(projectAssignments.role, "manager"),
          eq(projectAssignments.status, "active"),
        ),
      )
      .limit(1);
    if (!rows[0]) throw new CompanyCommandError("agent is not the accountable project manager");
  }

  private async requireCeoActor(organizationId: string, actorId: string) {
    if (!actorId.startsWith("agent/")) return;
    const profile = await this.profile(organizationId);
    if (!profile || actorId !== profile.ceoAgentId)
      throw new CompanyCommandError("only the configured CEO may change portfolio strategy");
  }

  private async requireVerifiedEvidence(
    organizationId: string,
    evidenceIds: string[],
    scope: { goalId?: string; projectId?: string; milestoneId?: string } = {},
  ) {
    const [rows, workItems] = await Promise.all([
      this.db
        .select({
          id: executionVerifications.id,
          workItemId: executionVerifications.workItemId,
          evidenceIdsJson: executionVerifications.evidenceIdsJson,
        })
        .from(executionVerifications)
        .where(
          and(
            eq(executionVerifications.organizationId, organizationId),
            eq(executionVerifications.status, "passed"),
          ),
        ),
      this.db
        .select({
          id: executionWorkItems.id,
          goalId: executionWorkItems.goalId,
          projectId: executionWorkItems.projectId,
          milestoneId: executionWorkItems.milestoneId,
        })
        .from(executionWorkItems)
        .where(eq(executionWorkItems.organizationId, organizationId)),
    ]);
    const workById = new Map(workItems.map((item) => [item.id, item]));
    const verified = new Set(
      rows.flatMap((row) => {
        const work = workById.get(row.workItemId);
        if (
          !work ||
          (scope.goalId && work.goalId !== scope.goalId) ||
          (scope.projectId && work.projectId !== scope.projectId) ||
          (scope.milestoneId && work.milestoneId !== scope.milestoneId)
        ) {
          return [];
        }
        return [row.id, ...parseStringArray(row.evidenceIdsJson)];
      }),
    );
    const missing = evidenceIds.filter((id) => !verified.has(id));
    if (missing.length > 0)
      throw new CompanyCommandError(
        `evidence is not backed by a passed verification: ${missing.join(", ")}`,
      );
  }

  private async result(
    command: CompanyCommand,
    id?: string,
    status?: string,
  ): Promise<CommandResult> {
    return {
      command: command.type,
      id,
      status,
      summary: await this.getSummary(command.organizationId),
    };
  }
}

function now() {
  return new Date().toISOString();
}
function safe(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}
function stableId(prefix: string, input: string) {
  return `${prefix}/${createHash("sha256").update(input).digest("hex").slice(0, 32)}`;
}
function mentionedAgent(body: string) {
  return body.match(/@agent\/[a-zA-Z0-9_-]+/)?.[0]?.slice(1) ?? null;
}
function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}
function parseStringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function companyRuntime(policy: Record<string, unknown>, provider: string): ExecutionTarget {
  if (provider === "dry_run_local") return { kind: "local", envPassthrough: false };
  if (policy.runtime !== undefined) {
    const configured = executionTargetSchema.safeParse(policy.runtime);
    if (!configured.success) throw new CompanyCommandError("company runtime policy is invalid");
    return configured.data;
  }
  return { kind: "local", envPassthrough: false };
}

function portfolioProjects(value: string): Array<{
  goalId: string;
  title: string;
  description: string;
  managerAgentId: string | null;
}> {
  const projects = parseObject(value).projects;
  if (!Array.isArray(projects)) return [];
  return projects.flatMap((project) => {
    if (!project || typeof project !== "object") return [];
    const row = project as Record<string, unknown>;
    if (typeof row.goalId !== "string" || typeof row.title !== "string") return [];
    return [
      {
        goalId: row.goalId,
        title: row.title,
        description: typeof row.description === "string" ? row.description : "",
        managerAgentId: typeof row.managerAgentId === "string" ? row.managerAgentId : null,
      },
    ];
  });
}
