import type { DbHandle } from "./connection.js";

const SQLITE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, email_verified INTEGER NOT NULL DEFAULT 0, image TEXT, two_factor_enabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS organization (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, logo TEXT, metadata TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, expires_at TEXT NOT NULL, token TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, ip_address TEXT, user_agent TEXT, user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, active_organization_id TEXT, two_factor_redirect INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS account (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, provider_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, access_token TEXT, refresh_token TEXT, id_token TEXT, access_token_expires_at TEXT, refresh_token_expires_at TEXT, scope TEXT, password TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS verification (id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS two_factor (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, secret TEXT NOT NULL, backup_codes TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS member (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, role TEXT NOT NULL DEFAULT 'owner', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS invitation (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE, email TEXT NOT NULL, role TEXT, status TEXT NOT NULL DEFAULT 'pending', expires_at TEXT NOT NULL, inviter_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS api_key (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE, created_by_user_id TEXT, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL DEFAULT '["read","write","deploy"]', last_used_at TEXT, expires_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, revoked_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS audit_log (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, actor_user_id TEXT, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT, metadata TEXT, ip TEXT, user_agent TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS audit_log_organization_id_created_at_idx ON audit_log(organization_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS login_attempt (id TEXT PRIMARY KEY, email TEXT NOT NULL, ip_address TEXT, user_id TEXT, organization_id TEXT, result TEXT NOT NULL, user_agent TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS login_attempt_email_ip_created_at_idx ON login_attempt(email, ip_address, created_at)`,
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
  `CREATE TABLE IF NOT EXISTS loop_controls (
    organization_id TEXT NOT NULL,
    loop_id TEXT NOT NULL,
    paused INTEGER NOT NULL DEFAULT 0,
    pause_reason TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (organization_id, loop_id)
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
  `CREATE UNIQUE INDEX IF NOT EXISTS wakeups_idem_uniq
    ON wakeups (idempotency_key)`,
  `CREATE INDEX IF NOT EXISTS wakeups_org_loop_requested_idx
    ON wakeups (organization_id, loop_id, requested_at)`,
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
    work_kind TEXT NOT NULL DEFAULT 'repository',
    delivery_mode TEXT NOT NULL DEFAULT 'commit',
    delivery_status TEXT NOT NULL DEFAULT 'pending',
    delivery_ref TEXT,
    delivery_commit_sha TEXT,
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
  `CREATE UNIQUE INDEX IF NOT EXISTS execution_work_items_org_idem_uniq
    ON execution_work_items (organization_id, idempotency_key)`,
  `CREATE INDEX IF NOT EXISTS execution_work_items_workflow_status_idx
    ON execution_work_items (organization_id, workflow_run_id, status)`,
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
  `CREATE UNIQUE INDEX IF NOT EXISTS workflow_runs_org_idem_uniq
    ON workflow_runs (organization_id, idempotency_key)`,
  `CREATE INDEX IF NOT EXISTS workflow_runs_source_time_idx
    ON workflow_runs (organization_id, source_type, source_id, created_at)`,
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
  `CREATE UNIQUE INDEX IF NOT EXISTS agent_attempts_work_number_uniq
    ON agent_attempts (work_item_id, role, attempt_number)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS agent_attempts_verification_uniq
    ON agent_attempts (verification_id)
    WHERE verification_id IS NOT NULL`,
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
    agent_id TEXT NOT NULL DEFAULT 'unknown',
    idempotency_key TEXT NOT NULL DEFAULT 'plan-unknown',
    prompt TEXT NOT NULL,
    timeout_ms INTEGER,
    harness_config_json TEXT NOT NULL DEFAULT '{}',
    workspace_policy_json TEXT NOT NULL DEFAULT '{"restore":"changes","cleanup":"always"}',
    runtime_config_json TEXT NOT NULL DEFAULT '{}',
    profile_hash TEXT NOT NULL DEFAULT 'profile-unknown',
    profile_snapshot_json TEXT NOT NULL DEFAULT '{}',
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
  `CREATE TABLE IF NOT EXISTS execution_raw_outputs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    stream TEXT NOT NULL,
    chunk TEXT NOT NULL,
    seq INTEGER NOT NULL,
    UNIQUE (attempt_id, seq)
  )`,
  `CREATE INDEX IF NOT EXISTS execution_raw_outputs_attempt_idx
    ON execution_raw_outputs (attempt_id, seq)`,
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
  `CREATE TABLE IF NOT EXISTS execution_external_actions (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    work_item_id TEXT NOT NULL REFERENCES execution_work_items(id) ON DELETE CASCADE,
    connector TEXT NOT NULL,
    operation TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    fingerprint TEXT NOT NULL DEFAULT '',
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    claim_owner TEXT,
    lease_expires_at TEXT,
    result_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE (organization_id, connector, idempotency_key)
  )`,
  `CREATE INDEX IF NOT EXISTS execution_external_actions_work_item_idx
    ON execution_external_actions (work_item_id)`,
  `CREATE TABLE IF NOT EXISTS execution_process_definitions (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    definition_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (organization_id, id, revision)
  )`,
  `CREATE INDEX IF NOT EXISTS execution_process_definitions_org_hash_idx
    ON execution_process_definitions (organization_id, content_hash)`,
  `CREATE TABLE IF NOT EXISTS execution_operator_runs (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    operator_agent_id TEXT NOT NULL,
    scope_type TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    workflow_run_id TEXT,
    status TEXT NOT NULL DEFAULT 'idle',
    observed_state_version INTEGER NOT NULL DEFAULT 0,
    latest_decision_id TEXT,
    wake_at TEXT,
    lease_owner TEXT,
    lease_expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (organization_id, scope_type, scope_id)
  )`,
  `CREATE INDEX IF NOT EXISTS execution_operator_runs_org_status_idx
    ON execution_operator_runs (organization_id, status)`,
  `CREATE TABLE IF NOT EXISTS execution_control_decisions (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    operator_run_id TEXT NOT NULL REFERENCES execution_operator_runs(id),
    sequence INTEGER NOT NULL,
    observed_state_version INTEGER NOT NULL,
    idempotency_key TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    parameters_json TEXT NOT NULL DEFAULT '{}',
    rationale TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'proposed',
    created_at TEXT NOT NULL,
    applied_at TEXT,
    UNIQUE (operator_run_id, sequence),
    UNIQUE (organization_id, idempotency_key)
  )`,
  `CREATE TABLE IF NOT EXISTS execution_escalations (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    operator_run_id TEXT,
    target_type TEXT NOT NULL,
    target_id TEXT,
    reason TEXT NOT NULL,
    evidence_ids_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'open',
    resolution TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS execution_escalations_org_status_idx
    ON execution_escalations (organization_id, status)`,
  `CREATE TABLE IF NOT EXISTS execution_operator_leases (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    operator_run_id TEXT NOT NULL REFERENCES execution_operator_runs(id),
    owner TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    released_at TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS execution_operator_leases_active_uniq
    ON execution_operator_leases (organization_id, operator_run_id)
    WHERE released_at IS NULL`,
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
  `CREATE TABLE IF NOT EXISTS autonomy_change_requests (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL UNIQUE,
    repository_id TEXT NOT NULL,
    base_commit_sha TEXT NOT NULL,
    branch_name TEXT NOT NULL,
    target_path TEXT NOT NULL,
    commit_sha TEXT,
    pull_request_number INTEGER,
    pull_request_url TEXT,
    status TEXT NOT NULL DEFAULT 'preparing',
    error TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS autonomy_change_requests_org_status_idx
    ON autonomy_change_requests (organization_id, status)`,
  `CREATE TABLE IF NOT EXISTS authority_edges (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    from_agent_id TEXT NOT NULL,
    to_agent_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (organization_id, from_agent_id, to_agent_id, relation)
  )`,
  `CREATE INDEX IF NOT EXISTS authority_edges_org_relation_idx
    ON authority_edges (organization_id, relation)`,
  `CREATE TABLE IF NOT EXISTS routing_decisions (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL,
    selected_agent_id TEXT,
    department_id TEXT,
    authority_path_json TEXT NOT NULL DEFAULT '[]',
    escalation_id TEXT,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (organization_id, idempotency_key)
  )`,
  `CREATE INDEX IF NOT EXISTS routing_decisions_org_status_idx
    ON routing_decisions (organization_id, status)`,
  `CREATE TABLE IF NOT EXISTS delegations (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    requested_by_agent_id TEXT,
    target_agent_id TEXT NOT NULL,
    work_item_id TEXT,
    authority_path_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (organization_id, idempotency_key)
  )`,
  `CREATE INDEX IF NOT EXISTS delegations_org_status_idx
    ON delegations (organization_id, status)`,
  `CREATE TABLE IF NOT EXISTS escalations (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    requested_by_agent_id TEXT,
    target_agent_id TEXT,
    risk TEXT NOT NULL,
    reason TEXT NOT NULL,
    context_json TEXT NOT NULL DEFAULT '{}',
    authority_path_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    resolved_by TEXT,
    resolution TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (organization_id, subject_type, subject_id)
  )`,
  `CREATE INDEX IF NOT EXISTS escalations_org_status_idx
    ON escalations (organization_id, status)`,
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
    check:
      "SELECT 1 FROM pragma_table_info('workflow_runs') WHERE name = 'process_definition_hash'",
    sql: "ALTER TABLE workflow_runs ADD COLUMN process_definition_hash TEXT",
  },
  {
    check: "SELECT 1 FROM pragma_table_info('workflow_runs') WHERE name = 'state_version'",
    sql: "ALTER TABLE workflow_runs ADD COLUMN state_version INTEGER NOT NULL DEFAULT 0",
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
    check: "SELECT 1 FROM pragma_table_info('execution_work_items') WHERE name = 'work_kind'",
    sql: "ALTER TABLE execution_work_items ADD COLUMN work_kind TEXT NOT NULL DEFAULT 'repository'",
  },
  {
    check: "SELECT 1 FROM pragma_table_info('execution_work_items') WHERE name = 'delivery_mode'",
    sql: "ALTER TABLE execution_work_items ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'commit'",
  },
  {
    check: "SELECT 1 FROM pragma_table_info('execution_work_items') WHERE name = 'delivery_status'",
    sql: "ALTER TABLE execution_work_items ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'pending'",
  },
  {
    check: "SELECT 1 FROM pragma_table_info('execution_work_items') WHERE name = 'delivery_ref'",
    sql: "ALTER TABLE execution_work_items ADD COLUMN delivery_ref TEXT",
  },
  {
    check:
      "SELECT 1 FROM pragma_table_info('execution_work_items') WHERE name = 'delivery_commit_sha'",
    sql: "ALTER TABLE execution_work_items ADD COLUMN delivery_commit_sha TEXT",
  },
  {
    check:
      "SELECT 1 FROM pragma_table_info('execution_work_items') WHERE name = 'delivery_claim_owner'",
    sql: "ALTER TABLE execution_work_items ADD COLUMN delivery_claim_owner TEXT",
  },
  {
    check:
      "SELECT 1 FROM pragma_table_info('execution_work_items') WHERE name = 'delivery_lease_expires_at'",
    sql: "ALTER TABLE execution_work_items ADD COLUMN delivery_lease_expires_at TEXT",
  },
  {
    check: "SELECT 1 FROM pragma_table_info('agent_attempts') WHERE name = 'harness_session_id'",
    sql: "ALTER TABLE agent_attempts ADD COLUMN harness_session_id TEXT",
  },
  {
    check:
      "SELECT 1 FROM pragma_table_info('execution_external_actions') WHERE name = 'fingerprint'",
    sql: "ALTER TABLE execution_external_actions ADD COLUMN fingerprint TEXT NOT NULL DEFAULT ''",
  },
  {
    check:
      "SELECT 1 FROM pragma_table_info('execution_external_actions') WHERE name = 'claim_owner'",
    sql: "ALTER TABLE execution_external_actions ADD COLUMN claim_owner TEXT",
  },
  {
    check:
      "SELECT 1 FROM pragma_table_info('execution_external_actions') WHERE name = 'lease_expires_at'",
    sql: "ALTER TABLE execution_external_actions ADD COLUMN lease_expires_at TEXT",
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
  {
    check: "SELECT 1 FROM pragma_table_info('execution_plans') WHERE name = 'agent_id'",
    sql: "ALTER TABLE execution_plans ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'unknown'",
  },
  {
    check: "SELECT 1 FROM pragma_table_info('execution_plans') WHERE name = 'idempotency_key'",
    sql: "ALTER TABLE execution_plans ADD COLUMN idempotency_key TEXT NOT NULL DEFAULT 'plan-unknown'",
  },
  {
    check: "SELECT 1 FROM pragma_table_info('execution_plans') WHERE name = 'harness_config_json'",
    sql: "ALTER TABLE execution_plans ADD COLUMN harness_config_json TEXT NOT NULL DEFAULT '{}'",
  },
  {
    check:
      "SELECT 1 FROM pragma_table_info('execution_plans') WHERE name = 'workspace_policy_json'",
    sql: 'ALTER TABLE execution_plans ADD COLUMN workspace_policy_json TEXT NOT NULL DEFAULT \'{"restore":"changes","cleanup":"always"}\'',
  },
  {
    check: "SELECT 1 FROM pragma_table_info('execution_plans') WHERE name = 'profile_hash'",
    sql: "ALTER TABLE execution_plans ADD COLUMN profile_hash TEXT NOT NULL DEFAULT 'profile-unknown'",
  },
  {
    check:
      "SELECT 1 FROM pragma_table_info('execution_plans') WHERE name = 'profile_snapshot_json'",
    sql: "ALTER TABLE execution_plans ADD COLUMN profile_snapshot_json TEXT NOT NULL DEFAULT '{}'",
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
const DATA_NORMALIZATION = [
  "UPDATE session_events SET seq = id WHERE seq = 0",
  `UPDATE execution_work_items
    SET status = 'blocked',
        delivery_status = 'failed',
        blocked_reason = 'Legacy delivery has no immutable commit evidence; rerun the work item'
    WHERE delivery_commit_sha IS NULL
      AND delivery_mode IN ('commit', 'pull_request')
      AND (
        status IN ('awaiting_verification', 'awaiting_approval')
        OR delivery_status IN ('ready', 'delivering')
      )`,
  `UPDATE execution_external_actions
    SET status = 'running',
        claim_owner = 'legacy_' || id,
        lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+10 minutes')
    WHERE status IN ('pending', 'running')
      AND claim_owner IS NULL`,
  `UPDATE execution_work_items
    SET delivery_status = 'delivered'
    WHERE status = 'completed'
      AND delivery_mode != 'pull_request'
      AND delivery_status = 'pending'`,
];

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
