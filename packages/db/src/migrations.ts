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
    repository_ids_json TEXT NOT NULL DEFAULT '[]',
    workflow_run_id TEXT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'proposed',
    definition_revision_id TEXT,
    source_commit_sha TEXT,
    branch_name TEXT,
    claimed_by_attempt_id TEXT,
    claimed_at TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    deadline_at TEXT,
    max_attempts INTEGER NOT NULL DEFAULT 1,
    retry_after TEXT,
    blocked_reason TEXT,
    governance_json TEXT NOT NULL DEFAULT '{}',
    idempotency_key TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS execution_work_item_dependencies (
    organization_id TEXT NOT NULL,
    work_item_id TEXT NOT NULL,
    depends_on_work_item_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (work_item_id, depends_on_work_item_id)
  )`,
  `CREATE INDEX IF NOT EXISTS execution_work_item_dependencies_work_idx
    ON execution_work_item_dependencies (work_item_id)`,
  `CREATE INDEX IF NOT EXISTS execution_work_item_dependencies_dependency_idx
    ON execution_work_item_dependencies (depends_on_work_item_id)`,
  `CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    goal_id TEXT NOT NULL,
    definition_revision_id TEXT NOT NULL,
    source_type TEXT,
    source_id TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    idempotency_key TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS loop_outputs (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    loop_id TEXT NOT NULL,
    workflow_run_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    severity TEXT,
    work_item_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (workflow_run_id, kind, source_ref)
  )`,
  `CREATE INDEX IF NOT EXISTS loop_outputs_loop_time_idx
    ON loop_outputs (organization_id, loop_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS agent_attempts (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    workflow_run_id TEXT NOT NULL,
    work_item_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    harness TEXT NOT NULL,
    harness_session_id TEXT,
    role TEXT NOT NULL DEFAULT 'maker',
    parent_attempt_id TEXT,
    verification_id TEXT,
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
  `CREATE TABLE IF NOT EXISTS execution_verifications (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    work_item_id TEXT NOT NULL,
    maker_attempt_id TEXT NOT NULL,
    checker_attempt_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    summary TEXT NOT NULL DEFAULT '',
    evidence_ids_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    completed_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS execution_verifications_work_item_idx
    ON execution_verifications (work_item_id)`,
  `CREATE TABLE IF NOT EXISTS execution_approvals (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    work_item_id TEXT NOT NULL,
    verification_id TEXT,
    status TEXT NOT NULL DEFAULT 'requested',
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    reason TEXT NOT NULL DEFAULT '',
    requested_at TEXT NOT NULL,
    expires_at TEXT,
    decided_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS execution_approvals_work_item_idx
    ON execution_approvals (work_item_id, status)`,
  `CREATE TABLE IF NOT EXISTS execution_budget_reservations (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    work_item_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    reserved_tokens INTEGER NOT NULL DEFAULT 0,
    reserved_cost_usd REAL NOT NULL DEFAULT 0,
    reserved_runs INTEGER NOT NULL DEFAULT 1,
    actual_tokens INTEGER NOT NULL DEFAULT 0,
    actual_cost_usd REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'reserved',
    created_at TEXT NOT NULL,
    settled_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS execution_budget_reservations_attempt_idx
    ON execution_budget_reservations (attempt_id)`,
  `CREATE INDEX IF NOT EXISTS execution_budget_reservations_scope_idx
    ON execution_budget_reservations (organization_id, scope, scope_id)`,
  `CREATE TABLE IF NOT EXISTS execution_governance_events (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    work_item_id TEXT,
    attempt_id TEXT,
    action TEXT NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    occurred_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS execution_governance_events_org_time_idx
    ON execution_governance_events (organization_id, occurred_at)`,
  `CREATE INDEX IF NOT EXISTS execution_governance_events_work_item_idx
    ON execution_governance_events (work_item_id)`,
  `CREATE TABLE IF NOT EXISTS memory_records (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    scope_json TEXT NOT NULL,
    sensitivity TEXT NOT NULL DEFAULT 'internal',
    provenance_json TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    retention_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'active',
    tags_json TEXT NOT NULL DEFAULT '[]',
    related_ids_json TEXT NOT NULL DEFAULT '[]',
    supersedes_id TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT,
    token_count INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS memory_records_org_status_idx
    ON memory_records (organization_id, status)`,
  `CREATE INDEX IF NOT EXISTS memory_records_scope_idx
    ON memory_records (organization_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS memory_records_source_hash_idx
    ON memory_records (organization_id, content_hash)`,
  `CREATE TABLE IF NOT EXISTS temporal_facts (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    predicate TEXT NOT NULL,
    value_json TEXT NOT NULL,
    value_type TEXT NOT NULL,
    valid_from TEXT,
    valid_to TEXT,
    confidence INTEGER NOT NULL DEFAULT 500,
    status TEXT NOT NULL DEFAULT 'proposed',
    source_memory_ids_json TEXT NOT NULL,
    provenance_json TEXT NOT NULL,
    supersedes_id TEXT,
    invalidated_at TEXT,
    last_verified_at TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS temporal_facts_org_subject_predicate_idx
    ON temporal_facts (organization_id, subject, predicate)`,
  `CREATE INDEX IF NOT EXISTS temporal_facts_org_status_idx
    ON temporal_facts (organization_id, status)`,
  `CREATE INDEX IF NOT EXISTS temporal_facts_supersedes_idx
    ON temporal_facts (supersedes_id)`,
  `CREATE TABLE IF NOT EXISTS knowledge_proposals (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    content TEXT NOT NULL,
    target_path TEXT NOT NULL,
    knowledge_type TEXT NOT NULL,
    tags_json TEXT NOT NULL DEFAULT '[]',
    source_memory_ids_json TEXT NOT NULL,
    fact_ids_json TEXT NOT NULL DEFAULT '[]',
    provenance_json TEXT NOT NULL,
    impact_summary TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'proposed',
    reviewed_by TEXT,
    review_reason TEXT,
    reviewed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS knowledge_proposals_org_status_idx
    ON knowledge_proposals (organization_id, status)`,
  `CREATE INDEX IF NOT EXISTS knowledge_proposals_target_path_idx
    ON knowledge_proposals (organization_id, target_path)`,
  `CREATE TABLE IF NOT EXISTS knowledge_change_requests (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL UNIQUE,
    target_path TEXT NOT NULL,
    base_commit_sha TEXT,
    content TEXT NOT NULL,
    impact_summary TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'proposed',
    decided_by TEXT,
    decision_reason TEXT,
    decided_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS knowledge_change_requests_org_status_idx
    ON knowledge_change_requests (organization_id, status)`,
  `CREATE TABLE IF NOT EXISTS departments (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    manager_agent_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (organization_id, name)
  )`,
  `CREATE INDEX IF NOT EXISTS departments_org_status_idx
    ON departments (organization_id, status)`,
  `CREATE TABLE IF NOT EXISTS department_members (
    department_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (department_id, agent_id)
  )`,
  `CREATE INDEX IF NOT EXISTS department_members_org_agent_idx
    ON department_members (organization_id, agent_id)`,
  `CREATE TABLE IF NOT EXISTS service_agents (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    department_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    heartbeat_at TEXT,
    last_run_at TEXT,
    failure_count INTEGER NOT NULL DEFAULT 0,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (organization_id, agent_id)
  )`,
  `CREATE INDEX IF NOT EXISTS service_agents_org_status_idx
    ON service_agents (organization_id, status)`,
  `CREATE TABLE IF NOT EXISTS autonomy_proposals (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    from_level TEXT NOT NULL,
    to_level TEXT NOT NULL,
    rationale TEXT NOT NULL,
    evidence_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'proposed',
    proposed_by TEXT NOT NULL,
    reviewed_by TEXT,
    review_reason TEXT NOT NULL DEFAULT '',
    reviewed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS autonomy_proposals_org_status_idx
    ON autonomy_proposals (organization_id, status)`,
  `CREATE INDEX IF NOT EXISTS autonomy_proposals_target_idx
    ON autonomy_proposals (organization_id, target_type, target_id)`,
];

/**
 * Schema-evolution statements. These run after the CREATE TABLE
 * IF NOT EXISTS statements above and bring older databases up to
 * the current shape. They are written to be idempotent so they
 * can run on every `db migrate` invocation.
 */
const SCHEMA_EVOLUTION: Array<{ check: string; sql: string }> = [
  {
    check: "SELECT 1 FROM pragma_table_info('execution_work_items') WHERE name = 'workflow_run_id'",
    sql: "ALTER TABLE execution_work_items ADD COLUMN workflow_run_id TEXT",
  },
  {
    check: "SELECT 1 FROM pragma_table_info('workflow_runs') WHERE name = 'source_type'",
    sql: "ALTER TABLE workflow_runs ADD COLUMN source_type TEXT",
  },
  {
    check: "SELECT 1 FROM pragma_table_info('workflow_runs') WHERE name = 'source_id'",
    sql: "ALTER TABLE workflow_runs ADD COLUMN source_id TEXT",
  },
  {
    check: "SELECT 1 FROM pragma_table_info('execution_work_items') WHERE name = 'priority'",
    sql: "ALTER TABLE execution_work_items ADD COLUMN priority INTEGER NOT NULL DEFAULT 0",
  },
  {
    check: "SELECT 1 FROM pragma_table_info('execution_work_items') WHERE name = 'deadline_at'",
    sql: "ALTER TABLE execution_work_items ADD COLUMN deadline_at TEXT",
  },
  {
    check: "SELECT 1 FROM pragma_table_info('execution_work_items') WHERE name = 'max_attempts'",
    sql: "ALTER TABLE execution_work_items ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 1",
  },
  {
    check: "SELECT 1 FROM pragma_table_info('execution_work_items') WHERE name = 'retry_after'",
    sql: "ALTER TABLE execution_work_items ADD COLUMN retry_after TEXT",
  },
  {
    check: "SELECT 1 FROM pragma_table_info('execution_work_items') WHERE name = 'blocked_reason'",
    sql: "ALTER TABLE execution_work_items ADD COLUMN blocked_reason TEXT",
  },
  {
    check: "SELECT 1 FROM pragma_table_info('execution_work_items') WHERE name = 'governance_json'",
    sql: "ALTER TABLE execution_work_items ADD COLUMN governance_json TEXT NOT NULL DEFAULT '{}'",
  },
  {
    check:
      "SELECT 1 FROM pragma_table_info('execution_work_items') WHERE name = 'repository_ids_json'",
    sql: "ALTER TABLE execution_work_items ADD COLUMN repository_ids_json TEXT NOT NULL DEFAULT '[]'",
  },
  {
    check: "SELECT 1 FROM pragma_table_info('agent_attempts') WHERE name = 'harness_session_id'",
    sql: "ALTER TABLE agent_attempts ADD COLUMN harness_session_id TEXT",
  },
  {
    check: "SELECT 1 FROM pragma_table_info('agent_attempts') WHERE name = 'role'",
    sql: "ALTER TABLE agent_attempts ADD COLUMN role TEXT NOT NULL DEFAULT 'maker'",
  },
  {
    check: "SELECT 1 FROM pragma_table_info('agent_attempts') WHERE name = 'parent_attempt_id'",
    sql: "ALTER TABLE agent_attempts ADD COLUMN parent_attempt_id TEXT",
  },
  {
    check: "SELECT 1 FROM pragma_table_info('agent_attempts') WHERE name = 'verification_id'",
    sql: "ALTER TABLE agent_attempts ADD COLUMN verification_id TEXT",
  },
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
