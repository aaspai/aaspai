import { closeDefaultDb, getDefaultDb, sessionEvents, sessions, wakeups } from "@aaspai/db";
import { Command } from "commander";
import { desc, eq } from "drizzle-orm";
import pc from "picocolors";

export function stateCommand(): Command {
  const cmd = new Command("state")
    .description("State views (default: show the dashboard)")
    .action(async () => {
      await showDashboard();
    });

  cmd
    .command("show")
    .description("Show the current dashboard (sessions + wakeups)")
    .action(async () => {
      await showDashboard();
    });

  cmd
    .command("md")
    .description("Output the state as a STATE.md document")
    .action(async () => {
      await showMd();
    });

  return cmd;
}

async function showDashboard(): Promise<void> {
  const handle = getDefaultDb();
  try {
    const recentSessions = await handle.db
      .select()
      .from(sessions)
      .orderBy(desc(sessions.startedAt))
      .limit(10);

    const recentWakeups = await handle.db
      .select()
      .from(wakeups)
      .orderBy(desc(wakeups.requestedAt))
      .limit(10);

    console.log(pc.cyan("# aaspai State"));
    console.log("");
    console.log("## Recent Sessions");
    if (recentSessions.length === 0) {
      console.log(pc.gray("  (none)"));
    } else {
      for (const s of recentSessions) {
        console.log(
          `  - ${s.id.slice(0, 24)}…  ${pc.gray(s.status)}  agent=${s.agentId}  adapter=${s.adapter}`,
        );
      }
    }
    console.log("");
    console.log("## Recent Wakeups");
    if (recentWakeups.length === 0) {
      console.log(pc.gray("  (none)"));
    } else {
      for (const w of recentWakeups) {
        console.log(`  - ${w.id.slice(0, 24)}…  ${pc.gray(w.status)}  ${w.reason ?? ""}`);
      }
    }
    console.log("");
    console.log(pc.gray("Tip: `aaspai state md > STATE.md` to write the file."));
  } finally {
    await closeDefaultDb();
    process.exit(0);
  }
}

async function showMd(): Promise<void> {
  const handle = getDefaultDb();
  try {
    const recentSessions = await handle.db
      .select()
      .from(sessions)
      .orderBy(desc(sessions.startedAt))
      .limit(20);
    const recentWakeups = await handle.db
      .select()
      .from(wakeups)
      .orderBy(desc(wakeups.requestedAt))
      .limit(20);

    const out: string[] = [];
    out.push("# Loop State", "");
    out.push(`Last updated: ${new Date().toISOString()}`, "");
    out.push("## Recent Sessions", "");
    if (recentSessions.length === 0) {
      out.push("_(no sessions yet)_");
    } else {
      for (const s of recentSessions) {
        out.push(`### ${s.status} — ${s.adapter} (${s.agentId})`);
        out.push("");
        out.push(`- id: \`${s.id}\``);
        out.push(`- started: ${s.startedAt ?? "?"}`);
        out.push(`- finished: ${s.finishedAt ?? "?"}`);
        out.push(`- duration: ${s.durationMs ?? "?"}ms`);
        if (s.errorMessage) out.push(`- error: ${s.errorMessage}`);
        if (s.resultJson) {
          try {
            const r = JSON.parse(s.resultJson) as { summary?: string };
            if (r.summary) {
              out.push("");
              out.push("**Summary:**", "");
              out.push("> " + r.summary.split("\n").join("\n> "));
            }
          } catch { /* ignore */ }
        }
        // Pull the first assistant message from the transcript
        const events = await handle.db
          .select()
          .from(sessionEvents)
          .where(eq(sessionEvents.sessionId, s.id))
          .orderBy(sessionEvents.seq)
          .limit(1);
        for (const e of events) {
          try {
            const p = JSON.parse(e.payloadJson) as { text?: string };
            if (p.text) {
              out.push("");
              out.push("**Agent response (excerpt):**", "");
              const preview = p.text.length > 800 ? `${p.text.slice(0, 800)}…` : p.text;
              out.push("```");
              out.push(preview);
              out.push("```");
            }
          } catch { /* ignore */ }
        }
        out.push("");
      }
    }
    out.push("## Recent Wakeups", "");
    if (recentWakeups.length === 0) {
      out.push("_(no wakeups yet)_");
    } else {
      for (const w of recentWakeups) {
        out.push(
          `- \`${w.id}\` — status=${w.status}, loop=${w.loopId}, ${w.reason ?? "(no reason)"}`,
        );
      }
    }
    process.stdout.write(out.join("\n") + "\n");
  } finally {
    await closeDefaultDb();
    process.exit(0);
  }
}
