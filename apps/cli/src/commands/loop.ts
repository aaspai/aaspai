import { Command } from "commander";
import pc from "picocolors";
import { FileAgentConfigSource, FileKnowledgeSource, FileLoopConfigSource } from "@aaspai/file-loader";
import { PatternRegistry, KillSwitch, Scheduler, LoopRunner, STARTER_PATTERNS, type ResolvedLoopPattern } from "@aaspai/loops";
import { Sessions } from "@aaspai/sessions";
import { SkillRegistry } from "@aaspai/skills";
import { getDefaultDb, closeDefaultDb } from "@aaspai/db";

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

  function runner(): LoopRunner {
    const agentSource = new FileAgentConfigSource(process.env.AASPAI_AGENTS_DIR ?? "./agents");
    const knowledgeSource = new FileKnowledgeSource(process.env.AASPAI_KNOWLEDGE_DIR ?? "./knowledge");
    const skills = new SkillRegistry();
    const sessions = new Sessions({ agentSource, knowledgeSource, skillRegistry: skills });
    return new LoopRunner({ organizationId: "default", loopSource: source(), sessions });
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
          console.log(`  ${id.padEnd(30)} ${pc.gray(`status=${cfg.status}, agent=${cfg.agent}, level=${cfg.autonomyLevel}`)}`);
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
        console.log(pc.gray(`status: ${cfg.status}  agent: ${cfg.agent}  level: ${cfg.autonomyLevel}`));
        console.log(pc.gray(`schedule: ${JSON.stringify(cfg.schedule)}`));
        console.log(pc.gray(`concurrency: ${cfg.concurrencyPolicy}  catchUp: ${cfg.catchUpPolicy}`));
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
            console.log(pc.yellow(`! Loop ${id} is in the filesystem but has no built-in discover/decide. Falling back to no-op.`));
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

      const r = runner();
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
