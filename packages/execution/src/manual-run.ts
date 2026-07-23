import type {
  AgentAttempt,
  ExecutionPlan,
  ExecutionWorkItem,
  WorkflowRun,
} from "@aaspai/contracts/execution";
import { executionPlanSchema } from "@aaspai/contracts/execution";
import type { ExecutionTarget, RunProcessResult } from "@aaspai/contracts/runtime";
import { GitPinnedDefinitionWorkspace } from "@aaspai/file-loader";
import type { GitRepository } from "@aaspai/git";
import { assertExecutionPlanCapabilities } from "./capabilities.js";
import { ExecutionPlanRunner } from "./plan-runner.js";
import type { ExecutionStore } from "./store.js";
import { LocalExecutionWorkspaceManager } from "./workspace-manager.js";

export interface ManualLocalExecutionInput {
  organizationId: string;
  goalTitle: string;
  projectTitle: string;
  blueprintRepositoryPath: string;
  projectRepositoryPath: string;
  workspaceRoot: string;
  prompt: string;
  idempotencyKey: string;
  agentId: string;
  harness: string;
  command: string;
  args?: readonly string[];
  target?: ExecutionTarget;
  signal?: AbortSignal;
}

export interface ManualLocalExecutionResult {
  workItem: ExecutionWorkItem;
  workflowRun: WorkflowRun;
  attempt: AgentAttempt;
  plan: ExecutionPlan;
  result: RunProcessResult;
  workspaceId: string;
  definitionPath: string;
}

/** The first complete local execution vertical: definitions and project stay separate. */
export class ManualLocalExecutionService {
  constructor(
    private readonly git: GitRepository,
    private readonly store: ExecutionStore,
  ) {}

  async run(input: ManualLocalExecutionInput): Promise<ManualLocalExecutionResult> {
    assertExecutionPlanCapabilities({
      harness: input.harness,
      target: input.target ?? { kind: "local", envPassthrough: false },
    });
    const blueprintCommit = await this.git.resolveCommit(input.blueprintRepositoryPath);
    const projectInfo = await this.git.inspect(input.projectRepositoryPath);
    const projectCommit = projectInfo.headSha;
    const goal = await this.store.createGoal({
      organizationId: input.organizationId,
      title: input.goalTitle,
    });
    const project = await this.store.createProject({
      organizationId: input.organizationId,
      goalId: goal.id,
      title: input.projectTitle,
    });
    const blueprintRepository = await this.store.createRepository({
      organizationId: input.organizationId,
      purpose: "blueprint",
      provider: "local",
      localPath: input.blueprintRepositoryPath,
    });
    const projectRepository = await this.store.createRepository({
      organizationId: input.organizationId,
      projectId: project.id,
      purpose: "project",
      provider: "local",
      localPath: input.projectRepositoryPath,
    });
    const revision = await this.store.createDefinitionRevision({
      organizationId: input.organizationId,
      repositoryId: blueprintRepository.id,
      commitSha: blueprintCommit,
      sourcePath: ".",
      contentHash: blueprintCommit,
    });
    const workItem = await this.store.createWorkItem({
      organizationId: input.organizationId,
      goalId: goal.id,
      projectId: project.id,
      repositoryId: projectRepository.id,
      title: input.prompt.slice(0, 512),
      definitionRevisionId: revision.id,
      sourceCommitSha: projectCommit,
      idempotencyKey: input.idempotencyKey,
    });
    const workflowRun = await this.store.createWorkflowRun({
      organizationId: input.organizationId,
      goalId: goal.id,
      definitionRevisionId: revision.id,
      idempotencyKey: input.idempotencyKey,
    });
    const attempt = await this.store.createAttempt({
      organizationId: input.organizationId,
      workflowRunId: workflowRun.id,
      workItemId: workItem.id,
      agentId: input.agentId,
      harness: input.harness,
    });
    if (!(await this.store.claimWorkItem(workItem.id, attempt.id))) {
      throw new Error(`Work item ${workItem.id} could not be claimed`);
    }
    const storedWorkItem = await this.store.getWorkItem(workItem.id);
    const storedWorkflowRun = await this.store.getWorkflowRun(workflowRun.id);
    if (!storedWorkItem || !storedWorkflowRun)
      throw new Error("Manual execution lineage disappeared");

    const definitions = new GitPinnedDefinitionWorkspace(this.git);
    const definitionMount = await definitions.open({
      repositoryPath: input.blueprintRepositoryPath,
      commitSha: blueprintCommit,
      workspaceRoot: input.workspaceRoot,
    });
    const workspaces = new LocalExecutionWorkspaceManager(
      this.git,
      this.store,
      async (repositoryId) => {
        if (repositoryId !== projectRepository.id) throw new Error("Unknown project repository");
        return input.projectRepositoryPath;
      },
    );
    let workspaceId: string | null = null;
    try {
      const workspace = await workspaces.prepare({
        organizationId: input.organizationId,
        attemptId: attempt.id,
        repositoryId: projectRepository.id,
        repositoryPath: input.projectRepositoryPath,
        baseCommitSha: projectCommit,
        workspaceRoot: input.workspaceRoot,
      });
      workspaceId = workspace.id;
      const plan = await this.store.createPlan({
        organizationId: input.organizationId,
        definitionRevisionId: revision.id,
        workItemId: workItem.id,
        attemptId: attempt.id,
        sourceSnapshot: {
          repositoryId: projectRepository.id,
          commitSha: projectCommit,
          branchName: projectInfo.branch ?? "detached",
          capturedAt: new Date().toISOString(),
        },
        target: input.target ?? { kind: "local", envPassthrough: false },
        harness: input.harness,
        prompt: input.prompt,
        runtimeConfig: { definitionsPath: definitionMount.path },
      });
      const result = await new ExecutionPlanRunner(this.store).run({
        plan: executionPlanSchema.parse(plan),
        workspace,
        command: input.command,
        args: input.args,
        env: { AASPAI_DEFINITIONS_PATH: definitionMount.path },
        signal: input.signal,
      });
      const finalAttempt = await this.store.getAttempt(attempt.id);
      if (!finalAttempt) throw new Error(`Agent attempt ${attempt.id} disappeared`);
      return {
        workItem: storedWorkItem,
        workflowRun: storedWorkflowRun,
        attempt: finalAttempt,
        plan,
        result,
        workspaceId: workspace.id,
        definitionPath: definitionMount.path,
      };
    } finally {
      if (workspaceId) await workspaces.release(workspaceId);
      await definitionMount.close();
    }
  }
}
