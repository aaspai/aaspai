import {
  closeDefaultDb,
  definitionRevisions,
  getDefaultDb,
  projects,
  repositories,
} from "@aaspai/db";
import { ExecutionStore } from "@aaspai/execution";
import { DEFAULT_LOOPS_DIR, FileLoopConfigSource } from "@aaspai/file-loader";
import {
  LoopControlStore,
  LoopRunner,
  PatternRegistry,
  type ResolvedLoopPattern,
  resolveFilePattern,
  Scheduler,
  STARTER_PATTERNS,
  StateStore,
} from "@aaspai/loops";
import { Command } from "commander";
import { eq } from "drizzle-orm";
import pc from "picocolors";

export function loopCommand(): Command {
  const cmd = new Command("loop").description("Loop operations");

  function source(): FileLoopConfigSource {
    return new FileLoopConfigSource(process.env.AASPAI_LOOPS_DIR ?? DEFAULT_LOOPS_DIR);
  }

  function registry(): PatternRegistry {
    const reg = new PatternRegistry();
    for (const p of STARTER_PATTERNS) reg.register(p);
    return reg;
  }

  async function runner(): Promise<LoopRunner> {
    const db = getDefaultDb().db;
    const store = new ExecutionStore(db);
    const lineage = await ensureLoopLineage(store);
    return new LoopRunner({
      organizationId: "default",
      loopSource: source(),
      execution: { store, lineage },
      controlStore: new LoopControlStore(db),
      stateStore: new StateStore(db),
    });
  }

  cmd
    .command("create <slug>")
    .description("Create an L1 loop definition and execute its first report-only run")
    .option("--title <title>", "Display title")
    .option("--agent <id>", "Agent id", "agent/operator")
    .option("--interval <seconds>", "Interval in seconds", "86400")
    .action(async (slug: string, options: { title?: string; agent: string; interval: string }) => {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
        console.log(pc.red("Loop slug must contain lowercase letters, numbers, and hyphens"));
        process.exit(2);
      }
      const seconds = Number(options.interval);
      if (!Number.isSafeInteger(seconds) || seconds < 60) {
        console.log(pc.red("Interval must be an integer of at least 60 seconds"));
        process.exit(2);
      }
      const title =
        options.title ??
        slug
          .split("-")
          .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
          .join(" ");
      const root = process.env.AASPAI_LOOPS_DIR ?? DEFAULT_LOOPS_DIR;
      const directory = join(root, slug);
      await mkdir(directory, { recursive: false });
      await Promise.all([
        writeFile(
          join(directory, "LOOP.md"),
          `---
id: loop/${slug}
type: LoopPattern
title: ${JSON.stringify(title)}
description: ${JSON.stringify(`${title} report-only loop`)}
timestamp: ${new Date().toISOString()}
schedule: { kind: interval, seconds: ${seconds} }
agent: ${options.agent}
autonomyLevel: L1
status: enabled
concurrencyPolicy: coalesce_if_active
catchUpPolicy: skip_missed
---

# ${title}

Discover relevant work and produce an actionable report. Do not change external state.
`,
          "utf8",
        ),
        writeFile(
          join(directory, "gate.yaml"),
          'denylist: [".env", ".env.*", "auth/**", "payments/**", "secrets/**"]\nmaxFilesChanged: 0\nactions:\n  execute: { allowed: true }\n',
          "utf8",
        ),
        writeFile(
          join(directory, "budget.yaml"),
          "perRun: { tokens: 50000, costUsd: 2, runs: 1 }\nperDay: { tokens: 200000, costUsd: 8, runs: 5 }\nsoft: 0.8\nhard: 1\n",
          "utf8",
        ),
      ]);
      const s = source();
      await s.start();
      try {
        const resolved = resolveFilePattern(await s.get(`loop/${slug}`));
        const outcome = await (await runner()).run(resolved, {
          triggerKey: `scaffold:${slug}`,
        });
        console.log(pc.green(`Created ${resolved.pattern.id}; first L1 run ${outcome.runId}`));
      } finally {
        await s.stop();
        await closeDefaultDb();
      }
    });

  cmd
    .command("list")
    .description("List all registered loops")
    .action(async () => {
      const s = source();
      await s.start();
      try {
        const ids = await s.list();
        console.log(pc.cyan(`Loops (${ids.length} file definitions)`));
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
          resolved = resolveFilePattern(loop, reg.get(id));
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
    .description("Pause a loop durably")
    .action(async (id: string) => {
      const pattern = await findPattern(id, source(), registry());
      if (!pattern) {
        console.log(pc.red(`Unknown loop: ${id}`));
        process.exit(3);
      }
      await new LoopControlStore().setPaused("default", pattern.pattern, true, "manual pause");
      await closeDefaultDb();
      console.log(pc.green(`✓ Paused ${id}`));
      process.exit(0);
    });

  cmd
    .command("resume <id>")
    .description("Resume a paused loop")
    .action(async (id: string) => {
      const pattern = await findPattern(id, source(), registry());
      if (!pattern) {
        console.log(pc.red(`Unknown loop: ${id}`));
        process.exit(3);
      }
      await new LoopControlStore().setPaused("default", pattern.pattern, false);
      await closeDefaultDb();
      console.log(pc.green(`✓ Resumed ${id}`));
      process.exit(0);
    });

  // Hide the unused Scheduler import warning — kept for future
  // tick-driven mode where the loop fires automatically.
  void Scheduler;

  return cmd;
}

async function findPattern(
  id: string,
  source: FileLoopConfigSource,
  registry: PatternRegistry,
): Promise<ResolvedLoopPattern | null> {
  await source.start();
  try {
    return (await source.has(id))
      ? resolveFilePattern(await source.get(id), registry.get(id))
      : registry.get(id);
  } finally {
    await source.stop();
  }
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

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
