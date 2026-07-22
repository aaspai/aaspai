import type { DbHandle } from "./connection.js";

const SQLITE_STATEMENTS = [
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
    payload_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS budget_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id TEXT NOT NULL,
    agent_id TEXT,
    session_id TEXT,
    usd REAL NOT NULL,
    kind TEXT NOT NULL,
    ts TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    ts TEXT NOT NULL
  )`,
];

export function runMigrations(handle: DbHandle): void {
  for (const stmt of SQLITE_STATEMENTS) {
    handle.db.run(stmt as never);
  }
}
