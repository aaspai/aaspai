import {
  closeDefaultDb,
  definitionRevisions,
  getDefaultDb,
  projects,
  repositories,
} from "@aaspai/db";
import { ExecutionStore } from "@aaspai/execution";
import { FileLoopConfigSource } from "@aaspai/file-loader";
import {
  KillSwitch,
  LoopRunner,
  PatternRegistry,
  type ResolvedLoopPattern,
  Scheduler,
  STARTER_PATTERNS,
} from "@aaspai/loops";
import { Command } from "commander";
import { eq } from "drizzle-orm";
import pc from "picocolors";

export function loopCommand(): Command {
  const cmd = new Command("loop").description("Loop operations");

  function source(): FileLoopConfigSource {
    return new FileLoopConfigSource(process.env.AASPAI_LOOPS_DIR ?? "./loops");
  }

  function registry(): PatternRegistry {
    const reg = new PatternRegistry();
    for (const p of STARTER_PATTERNS) reg.register(p);
    return reg;
  }

  async function runner(): Promise<LoopRunner> {
    const store = new ExecutionStore(getDefaultDb().db);
    const lineage = await ensureLoopLineage(store);
    return new LoopRunner({
      organizationId: "default",
      loopSource: source(),
      execution: { store, lineage },
    });
  }

  cmd
    .command("list")
    .description("List all registered loops")
    .action(async () => {
      const s = source();
      await s.start();
      try {
        const ids = await s.list();
        console.log(pc.cyan(`Loops (${ids.length} from files, 7 starter patterns registered)`));
        for (const id of ids) {
          const cfg = await s.get(id);
          console.log(
            `  ${id.padEnd(30)} ${pc.gray(`status=${cfg.status}, agent=${cfg.agent}, level=${cfg.autonomyLevel}`)}`,
          );
        }
      } finally {
        await s.stop();
        process.exit(0);
      }
    });

  cmd
    .command("show <id>")
    .description("Show the loop's config")
    .action(async (id: string) => {
      const s = source();
      await s.start();
      try {
        const cfg = await s.get(id);
        console.log(pc.cyan(`# ${cfg.title}`));
        console.log(pc.gray(`id: ${cfg.id}`));
        console.log(
          pc.gray(`status: ${cfg.status}  agent: ${cfg.agent}  level: ${cfg.autonomyLevel}`),
        );
        console.log(pc.gray(`schedule: ${JSON.stringify(cfg.schedule)}`));
        console.log(
          pc.gray(`concurrency: ${cfg.concurrencyPolicy}  catchUp: ${cfg.catchUpPolicy}`),
        );
      } finally {
        await s.stop();
        process.exit(0);
      }
    });

  cmd
    .command("fire <id>")
    .description("Fire a loop end-to-end (discover + decide + act)")
    .action(async (id: string) => {
      const reg = registry();
      let resolved: ResolvedLoopPattern | null = null;
      // Prefer the file-based loop if it exists
      const s = source();
      await s.start();
      try {
        if (await s.has(id)) {
          const loop = await s.get(id);
          // For now the file-based loop uses the daily-triage discover/decide
          // (the only one wired). Other file-based loops can register their own.
          const builtin = reg.get(id);
          if (builtin) {
            resolved = builtin;
          } else {
            console.log(
              pc.yellow(
                `! Loop ${id} is in the filesystem but has no built-in discover/decide. Falling back to no-op.`,
              ),
            );
            resolved = {
              pattern: loop,
              discover: async () => [],
              decide: async () => ({ kind: "noop" as const }),
            };
          }
        }
      } finally {
        await s.stop();
      }
      if (!resolved) {
        // Check starter patterns
        resolved = reg.get(id);
      }
      if (!resolved) {
        console.log(pc.red(`✗ Unknown loop: ${id}`));
        process.exit(3);
      }

      const r = await runner();
      console.log(pc.cyan(`Firing ${resolved.pattern.id} (discover + decide + act)...`));
      const outcome = await r.run(resolved);
      console.log(pc.green(`✓ Loop run complete`));
      console.log(`  runId:      ${outcome.runId}`);
      console.log(`  items:      ${outcome.items.length}`);
      console.log(`  fired:      ${outcome.fired}`);
      console.log(`  reported:   ${outcome.reported}`);
      console.log(`  escalated:  ${outcome.escalated}`);
      console.log(`  noops:      ${outcome.noops}`);
      console.log(`  duration:   ${outcome.durationMs}ms`);
      await closeDefaultDb();
      process.exit(0);
    });

  cmd
    .command("pause <id>")
    .description("Pause a loop (kill switch)")
    .action((id: string) => {
      const ks = new KillSwitch();
      ks.pauseLoop(id, "manual pause");
      console.log(pc.green(`✓ Paused ${id}`));
      process.exit(0);
    });

  cmd
    .command("resume <id>")
    .description("Resume a paused loop")
    .action((id: string) => {
      const ks = new KillSwitch();
      ks.resumeLoop(id);
      console.log(pc.green(`✓ Resumed ${id}`));
      process.exit(0);
    });

  // Hide the unused Scheduler import warning — kept for future
  // tick-driven mode where the loop fires automatically.
  void Scheduler;

  return cmd;
}

async function ensureLoopLineage(store: ExecutionStore) {
  const db = getDefaultDb().db;
  const goalId = "goal:loops:default";
  const projectId = "project:loops:default";
  const repositoryId = "repo:loops:default";
  const definitionRevisionId = "revision:loops:default";
  if (!(await store.getGoal(goalId))) {
    await store.createGoal({
      id: goalId,
      organizationId: "default",
      title: "Company loop execution",
      description: "Durable work generated by company loops.",
      status: "active",
    });
  }
  const project = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project[0]) {
    await store.createProject({
      id: projectId,
      organizationId: "default",
      goalId,
      title: "Loop work",
      description: "Execution project for bounded loop actions.",
    });
  }
  const repository = await db
    .select()
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
    .limit(1);
  if (!repository[0]) {
    await store.createRepository({
      id: repositoryId,
      organizationId: "default",
      projectId,
      purpose: "blueprint",
      provider: "local",
      localPath: process.env.AASPAI_DEFINITIONS_DIR ?? ".",
    });
  }
  const revision = await db
    .select()
    .from(definitionRevisions)
    .where(eq(definitionRevisions.id, definitionRevisionId))
    .limit(1);
  if (!revision[0]) {
    await store.createDefinitionRevision({
      id: definitionRevisionId,
      organizationId: "default",
      repositoryId,
      commitSha: "0000000",
      sourcePath: process.env.AASPAI_DEFINITIONS_DIR ?? ".",
      dirty: true,
      contentHash: "cli-loop-definition",
    });
  }
  return { goalId, projectId, repositoryId, definitionRevisionId };
}
