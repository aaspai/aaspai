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
    payload_json TEXT NOT NULL,
    seq INTEGER NOT NULL DEFAULT 0
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
  `CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'planned',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    goal_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS repositories (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT,
    purpose TEXT NOT NULL,
    provider TEXT NOT NULL,
    local_path TEXT NOT NULL,
    remote_url TEXT,
    default_branch TEXT NOT NULL DEFAULT 'main',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS definition_revisions (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    source_path TEXT NOT NULL,
    dirty INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS execution_work_items (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    goal_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'proposed',
    definition_revision_id TEXT,
    source_commit_sha TEXT,
    branch_name TEXT,
    claimed_by_attempt_id TEXT,
    claimed_at TEXT,
    idempotency_key TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    goal_id TEXT NOT NULL,
    definition_revision_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    idempotency_key TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS agent_attempts (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    workflow_run_id TEXT NOT NULL,
    work_item_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    harness TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    attempt_number INTEGER NOT NULL DEFAULT 1,
    timeout_ms INTEGER,
    cancel_requested_at TEXT,
    started_at TEXT,
    finished_at TEXT,
    error TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS execution_workspaces (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    path TEXT NOT NULL,
    branch_name TEXT NOT NULL,
    base_commit_sha TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    released_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS resource_locks (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    owner_attempt_id TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    lease_expires_at TEXT NOT NULL,
    released_at TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS resource_locks_active_uniq
    ON resource_locks (organization_id, resource_type, resource_id)
    WHERE released_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS execution_plans (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    definition_revision_id TEXT NOT NULL,
    work_item_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    source_snapshot_json TEXT NOT NULL,
    target_json TEXT NOT NULL,
    harness TEXT NOT NULL,
    prompt TEXT NOT NULL,
    timeout_ms INTEGER,
    runtime_config_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS execution_artifacts (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    media_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS execution_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    seq INTEGER NOT NULL
  )`,
];

/**
 * Schema-evolution statements. These run after the CREATE TABLE
 * IF NOT EXISTS statements above and bring older databases up to
 * the current shape. They are written to be idempotent so they
 * can run on every `db migrate` invocation.
 */
const SCHEMA_EVOLUTION: Array<{ check: string; sql: string }> = [
  // session_events.seq was added after the initial scaffold. Older
  // DBs need it added; we back-fill with the row id so the order
  // is preserved.
  {
    check: "SELECT 1 FROM pragma_table_info('session_events') WHERE name = 'seq'",
    sql: "ALTER TABLE session_events ADD COLUMN seq INTEGER NOT NULL DEFAULT 0",
  },
];

// Existing databases receive `0` for the newly added column. The runtime
// assigns sequence numbers from 1, so zero is an unambiguous marker for old
// rows that need to be ordered by their original autoincrement id.
const DATA_NORMALIZATION = ["UPDATE session_events SET seq = id WHERE seq = 0"];

export function runMigrations(handle: DbHandle): void {
  for (const stmt of SQLITE_STATEMENTS) {
    handle.db.run(stmt as never);
  }
  for (const evo of SCHEMA_EVOLUTION) {
    // `check` returns rows when the column already exists. If it
    // returns no rows, the column is missing and we run the ALTER.
    const present = handle.db.all(evo.check as never);
    if (!present || (Array.isArray(present) && present.length === 0)) {
      try {
        handle.db.run(evo.sql as never);
      } catch (err) {
        // Swallow: most likely a race where another process added
        // the column between the check and the ALTER.
        const msg = String((err as Error).message ?? err);
        if (!/duplicate column|already exists/i.test(msg)) throw err;
      }
    }
  }
  for (const stmt of DATA_NORMALIZATION) {
    handle.db.run(stmt as never);
  }
}
