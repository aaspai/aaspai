import {
  type CompanyObjectiveSummary,
  type CompanyProjectSummary,
  type CompanyStrategicSummary,
  companyObjectiveSummarySchema,
  companyProfileSchema,
  companyProjectSummarySchema,
  companyStrategicSummarySchema,
  type JsonObject,
  type JsonValue,
  jsonObjectSchema,
  jsonValueSchema,
  milestoneSchema,
  projectAssignmentSchema,
} from "@aaspai/contracts";
import {
  companyProfiles,
  eq,
  goals,
  milestones,
  objectiveMeasurements,
  processBindings,
  projectAssignments,
  projectObjectives,
  projects,
  type SqliteDb,
} from "@aaspai/db";

export class StrategicReadModelService {
  constructor(private readonly db: SqliteDb) {}

  async getSummary(organizationId: string): Promise<CompanyStrategicSummary> {
    const [
      profileRows,
      goalRows,
      projectRows,
      links,
      measurements,
      assignments,
      milestoneRows,
      bindings,
    ] = await Promise.all([
      this.db
        .select()
        .from(companyProfiles)
        .where(eq(companyProfiles.organizationId, organizationId)),
      this.db.select().from(goals).where(eq(goals.organizationId, organizationId)),
      this.db.select().from(projects).where(eq(projects.organizationId, organizationId)),
      this.db
        .select()
        .from(projectObjectives)
        .where(eq(projectObjectives.organizationId, organizationId)),
      this.db
        .select()
        .from(objectiveMeasurements)
        .where(eq(objectiveMeasurements.organizationId, organizationId)),
      this.db
        .select()
        .from(projectAssignments)
        .where(eq(projectAssignments.organizationId, organizationId)),
      this.db.select().from(milestones).where(eq(milestones.organizationId, organizationId)),
      this.db
        .select()
        .from(processBindings)
        .where(eq(processBindings.organizationId, organizationId)),
    ]);

    const companyGoals = goalRows.filter((goal) => !goal.id.startsWith("goal:loops:"));
    const companyGoalIds = new Set(companyGoals.map((goal) => goal.id));
    const objectiveSummaries = companyGoals.map((goal) => {
      const summary = {
        id: goal.id,
        organizationId: goal.organizationId,
        title: goal.title,
        description: goal.description,
        status: goal.status,
        priority: goal.priority,
        horizon: goal.horizon,
        successCriteria: parseJsonValue(goal.successCriteriaJson, []),
        targetAt: goal.targetAt,
        reviewCadence: goal.reviewCadence,
        ownerAgentId: goal.ownerAgentId,
        projectCount: links.filter((link) => link.goalId === goal.id).length,
        measurementCount: measurements.filter((measurement) => measurement.goalId === goal.id)
          .length,
      } satisfies CompanyObjectiveSummary;
      return companyObjectiveSummarySchema.parse(summary);
    });

    const projectSummaries = projectRows
      .filter((project) => companyGoalIds.has(project.goalId))
      .map((project) => {
        const summary = {
          id: project.id,
          organizationId: project.organizationId,
          goalId: project.goalId,
          title: project.title,
          description: project.description,
          status: project.status,
          managerAgentId: project.managerAgentId,
          budget: parseJsonObject(project.budgetJson),
          riskLevel: project.riskLevel,
          reviewCadence: project.reviewCadence,
          healthStatus: project.healthStatus,
          successCriteria: parseJsonValue(project.successCriteriaJson, []),
          objectiveIds: links
            .filter((link) => link.projectId === project.id)
            .map((link) => link.goalId),
          assignments: assignments
            .filter((assignment) => assignment.projectId === project.id)
            .map((assignment) => projectAssignmentSchema.parse(assignment)),
          milestones: milestoneRows
            .filter((milestone) => milestone.projectId === project.id)
            .sort((a, b) => a.sequence - b.sequence)
            .map(({ acceptanceJson, ...milestone }) => ({
              ...milestone,
              acceptance: parseJsonObject(acceptanceJson),
            }))
            .map((milestone) => milestoneSchema.parse(milestone)),
          processBindingCount: bindings.filter((binding) => binding.projectId === project.id)
            .length,
        } satisfies CompanyProjectSummary;
        return companyProjectSummarySchema.parse(summary);
      });

    const profile = profileRows[0]
      ? (() => {
          const { policyJson, ...profile } = profileRows[0];
          return companyProfileSchema.parse({ ...profile, policy: parseJsonObject(policyJson) });
        })()
      : null;
    return companyStrategicSummarySchema.parse({
      organizationId,
      generatedAt: new Date().toISOString(),
      profile,
      objectives: objectiveSummaries,
      projects: projectSummaries,
    });
  }
}

function parseJsonValue(value: string, fallback: JsonValue): JsonValue {
  try {
    const parsed = jsonValueSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}

function parseJsonObject(value: string): JsonObject {
  const parsed = parseJsonValue(value, {});
  const object = jsonObjectSchema.safeParse(parsed);
  return object.success ? object.data : {};
}
