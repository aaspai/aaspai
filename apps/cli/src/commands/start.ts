import {
  FileAgentConfigSource,
  FileKnowledgeSource,
  FileLoopConfigSource,
} from "@aaspai/file-loader";
import { KillSwitch, PatternRegistry, Scheduler, STARTER_PATTERNS } from "@aaspai/loops";
import { Command } from "commander";
import pc from "picocolors";

export function startCommand(): Command {
  const cmd = new Command("start").description("Start the aaspai daemon");

  cmd.option("--once", "run a single tick and exit (for cron)", false).action(async (opts) => {
    console.log(pc.cyan("Starting aaspai daemon..."));

    // Wire up the file-based sources
    const agents = new FileAgentConfigSource(process.env.AASPAI_AGENTS_DIR ?? "./agents");
    const knowledge = new FileKnowledgeSource(process.env.AASPAI_KNOWLEDGE_DIR ?? "./knowledge");
    const loops = new FileLoopConfigSource(process.env.AASPAI_LOOPS_DIR ?? "./loops");

    await agents.start();
    await knowledge.start();
    await loops.start();

    console.log(pc.green("✓ File-based config loaded"));
    console.log(`  agents:    ${(await agents.list()).length}`);
    console.log(`  knowledge: ${(await knowledge.list()).length}`);
    console.log(`  loops:     ${(await loops.list()).length}`);

    // Build the pattern registry from the loaded loops + the built-in starter patterns
    const registry = new PatternRegistry();
    for (const p of STARTER_PATTERNS) registry.register(p);
    const fileLoopIds = await loops.list();
    console.log(
      pc.gray(
        `  registered ${fileLoopIds.length} file-based loops + ${STARTER_PATTERNS.length} starter patterns`,
      ),
    );

    const killSwitch = new KillSwitch();
    const scheduler = new Scheduler(registry, killSwitch, {
      organizationId: "default",
      tickIntervalMs: 60_000,
    });

    if (opts.once) {
      const result = await scheduler.tick(new Date());
      console.log(pc.cyan("Single tick result"));
      console.log(`  fired:   ${result.fired}`);
      console.log(`  deferred: ${result.deferred}`);
      console.log(`  skipped: ${result.skipped}`);
    } else {
      scheduler.start();
      console.log(pc.green("✓ Scheduler started (60s tick)"));
      console.log(pc.gray("  Press Ctrl+C to stop"));

      const shutdown = async () => {
        console.log(pc.yellow("\nShutting down..."));
        scheduler.stop();
        await agents.stop();
        await knowledge.stop();
        await loops.stop();
        console.log(pc.green("✓ Stopped"));
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      // Keep alive
      await new Promise(() => {});
    }
  });

  return cmd;
}
