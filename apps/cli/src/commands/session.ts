import { randomUUID } from "node:crypto";
import { FileAgentConfigSource, FileKnowledgeSource } from "@aaspai/file-loader";
import { Sessions } from "@aaspai/sessions";
import { SkillRegistry } from "@aaspai/skills";
import { Command } from "commander";
import pc from "picocolors";

export function sessionCommand(): Command {
  const cmd = new Command("session").description("Session operations");

  function makeSessions(): Sessions {
    const agentSource = new FileAgentConfigSource(process.env.AASPAI_AGENTS_DIR ?? "./agents");
    const knowledgeSource = new FileKnowledgeSource(
      process.env.AASPAI_KNOWLEDGE_DIR ?? "./knowledge",
    );
    const skills = new SkillRegistry();
    return new Sessions({ agentSource, knowledgeSource, skillRegistry: skills });
  }

  cmd
    .command("list")
    .description("List recent sessions")
    .action(async () => {
      const s = makeSessions();
      const rows = await s.list();
      console.log(pc.cyan(`Sessions (${rows.length})`));
      for (const r of rows.slice(0, 20)) {
        console.log(`  ${r.id.padEnd(40)} ${pc.gray(`status=${r.status}, agent=${r.agentId}`)}`);
      }
      process.exit(0);
    });

  cmd
    .command("show <id>")
    .description("Show a session")
    .action(async (id: string) => {
      const s = makeSessions();
      const r = await s.get(id);
      if (!r) {
        console.log(pc.red(`✗ Session ${id} not found`));
        process.exit(3);
      }
      console.log(pc.cyan(`Session ${r.id}`));
      console.log(`  status:    ${r.status}`);
      console.log(`  agent:     ${r.agentId}`);
      console.log(`  adapter:   ${r.adapter}`);
      console.log(`  started:   ${r.startedAt ?? "-"}`);
      console.log(`  finished:  ${r.finishedAt ?? "-"}`);
      process.exit(0);
    });

  cmd
    .command("start")
    .description("Start a one-off session")
    .option("--agent <id>", "agent to use", "agent/operator")
    .option("--prompt <text>", "the prompt", "hello from aaspai")
    .option("--adapter <type>", "override adapter", "claude_local")
    .option("--runtime <type>", "override runtime", "local")
    .action(async (opts) => {
      const s = makeSessions();
      console.log(pc.cyan(`Starting session for ${opts.agent}...`));
      const result = await s.execute({
        organizationId: "default",
        agentId: opts.agent,
        adapter: opts.adapter,
        runtime: { kind: opts.runtime },
        prompt: opts.prompt,
        config: {},
        skills: [],
        budget: {},
        idempotencyKey: randomUUID(),
      });
      console.log(pc.green(`✓ Session ${result.sessionId}`));
      console.log(`  status:  ${result.status}`);
      console.log(`  summary: ${result.summary ?? "(no summary)"}`);
      // Stop the underlying sources so the process exits.
      const maybeStop = (src: unknown) => {
        if (src && typeof (src as { stop?: () => Promise<void> }).stop === "function") {
          return (src as { stop: () => Promise<void> }).stop();
        }
      };
      await Promise.all([
        Promise.resolve(
          maybeStop((s as unknown as { opts: { agentSource: unknown } }).opts.agentSource),
        ),
        Promise.resolve(
          maybeStop((s as unknown as { opts: { knowledgeSource: unknown } }).opts.knowledgeSource),
        ),
      ]);
      process.exit(0);
    });

  cmd
    .command("pause <id>")
    .description("Pause a running session")
    .action(async (id: string) => {
      const s = makeSessions();
      await s.pause(id, "manual pause");
      console.log(pc.green(`✓ Paused ${id}`));
    });

  cmd
    .command("resume <id>")
    .description("Resume a paused session")
    .action(async (id: string) => {
      const s = makeSessions();
      await s.resume(id);
      console.log(pc.green(`✓ Resumed ${id}`));
    });

  cmd
    .command("stop <id>")
    .description("Stop a running session")
    .action(async (id: string) => {
      const s = makeSessions();
      await s.stop(id, "manual stop");
      console.log(pc.green(`✓ Stopped ${id}`));
    });

  cmd
    .command("cancel <id>")
    .description("Cancel a running session")
    .action(async (id: string) => {
      const s = makeSessions();
      await s.cancel(id, "manual cancel");
      console.log(pc.green(`✓ Cancelled ${id}`));
    });

  return cmd;
}
