import {
  auditEvents,
  budgetLedger,
  closeDefaultDb,
  detectBackend,
  getDefaultDb,
  loops,
  runMigrations,
  sessionEvents,
  sessions,
  wakeups,
} from "@aaspai/db";
import { Command } from "commander";
import pc from "picocolors";
import { sql } from "drizzle-orm";

export function dbCommand(): Command {
  const cmd = new Command("db").description("Database operations");

  cmd
    .command("status")
    .description("Show database status, backend, row counts")
    .action(async () => {
      const url = process.env.AASPAI_DB ?? "sqlite:./.aaspai/state.db";
      const backend = detectBackend(url);
      await ensureMigrated();
      const handle = getDefaultDb();
      try {
        const counts = await Promise.all([
          safeCount(handle.db, loops),
          safeCount(handle.db, wakeups),
          safeCount(handle.db, sessions),
          safeCount(handle.db, sessionEvents),
          safeCount(handle.db, budgetLedger),
          safeCount(handle.db, auditEvents),
        ]);
        console.log(pc.cyan("Database status"));
        console.log(`  backend:  ${backend}`);
        console.log(`  url:      ${url}`);
        console.log("");
        console.log("  tables:");
        const labels = [
          "loops",
          "wakeups",
          "sessions",
          "session_events",
          "budget_ledger",
          "audit_events",
        ];
        for (let i = 0; i < labels.length; i++) {
          const n = counts[i] ?? 0;
          const label = labels[i] ?? "";
          console.log(`    ${label.padEnd(20)} ${n}`);
        }
      } finally {
        await closeDefaultDb();
      }
    });

  cmd
    .command("migrate")
    .description("Create the database tables (foundation: idempotent)")
    .action(async () => {
      await ensureMigrated();
      console.log(pc.green("✓ Tables are up to date"));
    });

  cmd
    .command("backup")
    .description("Backup the database")
    .action(async () => {
      const url = process.env.AASPAI_DB ?? "sqlite:./.aaspai/state.db";
      const backend = detectBackend(url);
      if (backend !== "sqlite") {
        console.log(pc.yellow("Backup is only implemented for SQLite. Use pg_dump for Postgres."));
        return;
      }
      const path = url.slice("sqlite:".length);
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const backupPath = path.replace(/\.db$/, `.${ts}.db`);
      const { copyFile } = await import("node:fs/promises");
      await copyFile(path, backupPath);
      console.log(pc.green(`✓ Backed up to ${backupPath}`));
    });

  return cmd;
}

async function ensureMigrated(): Promise<void> {
  const handle = getDefaultDb();
  runMigrations(handle);
}

async function safeCount(db: unknown, table: unknown): Promise<number> {
  try {
    const result = await (
      db as {
        select: (cols: unknown) => {
          from: (t: unknown) => { all: () => Promise<Array<{ c: number }>> };
        };
      }
    )
      .select({ c: sql<number>`count(*)` })
      .from(table)
      .all();
    return Number(result[0]?.c ?? 0);
  } catch {
    return 0;
  }
}
