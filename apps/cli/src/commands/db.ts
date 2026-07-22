import {
  auditEvents,
  budgetLedger,
  closeDefaultDb,
  detectBackend,
  getDefaultDb,
  loops,
  sessionEvents,
  sessions,
  wakeups,
} from "@aaspai/db";
import { Command } from "commander";
import { sql } from "drizzle-orm";
import pc from "picocolors";

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
  // Foundation: a hand-rolled CREATE TABLE IF NOT EXISTS for each phase-2
  // table. Phase 4 switches to drizzle-kit-generated migrations.
  const stmts = [
    `CREATE TABLE IF NOT EXISTS loops (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      pattern_id TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      gate_json TEXT NOT NULL DEFAULT '{}',
      budget_json TEXT NOT NULL DEFAULT '{}',
      schedule_json TEXT NOT NULL DEFAULT '{}',
      paused INTEGER NOT NULL DEFAULT 0,
      pause_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS wakeups (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      loop_id TEXT NOT NULL,
      source TEXT NOT NULL,
      trigger_detail TEXT,
      reason TEXT,
      agent_id TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'queued',
      coalesced_into_wakeup_id TEXT,
      idempotency_key TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      requested_by_actor_id TEXT,
      requested_by_actor_type TEXT,
      claimed_at TEXT,
      finished_at TEXT,
      session_id TEXT,
      error TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      wakeup_id TEXT NOT NULL DEFAULT 'manual',
      agent_id TEXT NOT NULL,
      adapter TEXT NOT NULL,
      runtime_json TEXT NOT NULL DEFAULT '{}',
      prompt TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'queued',
      session_id TEXT,
      session_params_json TEXT,
      session_display_id TEXT,
      result_json TEXT,
      usage_json TEXT,
      cost_usd REAL,
      error_family TEXT,
      error_code TEXT,
      error_message TEXT,
      pending_question_json TEXT,
      started_at TEXT,
      finished_at TEXT,
      duration_ms INTEGER,
      parent_session_id TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      seq INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS budget_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      window TEXT NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      runs INTEGER NOT NULL DEFAULT 1,
      ts TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      correlation_id TEXT,
      occurred_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      metadata_json TEXT
    )`,
  ];
  const sqlite = handle.raw as { exec: (sql: string) => void };
  for (const stmt of stmts) sqlite.exec(stmt);
  await closeDefaultDb();
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
