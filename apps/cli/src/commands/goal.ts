import { getDefaultDb, runMigrations } from "@aaspai/db";
import { ExecutionStore } from "@aaspai/execution";
import { Command } from "commander";
import pc from "picocolors";

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function goalCommand(): Command {
  const cmd = new Command("goal").description("Create durable goals and work pipelines");

  cmd
    .command("create")
    .requiredOption("--title <title>", "measurable company outcome")
    .option("--description <text>", "goal description")
    .option("--project <title>", "project title", "Delivery")
    .option("--step <title>", "pipeline step; repeat in dependency order", collect, [])
    .option("--owner <agent-id>", "delivery owner", "agent/operator")
    .option("--validation-owner <agent-id>", "independent validation owner", "agent/tester")
    .option("--json", "print JSON")
    .action(async (options) => {
      const steps = options.step as string[];
      if (steps.length === 0) throw new Error("At least one --step is required");
      const db = getDefaultDb();
      runMigrations(db);
      const store = new ExecutionStore(db.db);
      const organizationId = "default";
      const goal = await store.createGoal({
        organizationId,
        title: options.title,
        description: options.description,
      });
      const project = await store.createProject({
        organizationId,
        goalId: goal.id,
        title: options.project,
      });
      const repository = await store.createRepository({
        organizationId,
        projectId: project.id,
        purpose: "project",
        provider: "local",
        localPath: process.cwd(),
      });
      const workItems: Awaited<ReturnType<ExecutionStore["createWorkItem"]>>[] = [];
      let previousWorkItemId: string | undefined;
      for (const [index, title] of steps.entries()) {
        const workItem = await store.createWorkItem({
          organizationId,
          goalId: goal.id,
          projectId: project.id,
          repositoryId: repository.id,
          title,
          status: index === 0 ? "ready" : "proposed",
          priority: steps.length - index,
          idempotencyKey: `goal:${goal.id}:step:${index}`,
          metadata: {
            ownerAgentId: options.owner,
            validationOwnerAgentId: options.validationOwner,
          },
        });
        if (previousWorkItemId) {
          await store.addWorkItemDependency(organizationId, workItem.id, previousWorkItemId);
        }
        workItems.push(workItem);
        previousWorkItemId = workItem.id;
      }
      const result = { goal, project, repository, workItems };
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(pc.green(`✓ Goal ${goal.id}`));
        console.log(`  project: ${project.id}`);
        for (const item of workItems) console.log(`  work:    ${item.id}  ${item.title}`);
      }
    });

  return cmd;
}
