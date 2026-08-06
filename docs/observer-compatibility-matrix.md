# AI Observer — Aaspai Compatibility Matrix and Approved Deviations

Status: living document, updated during implementation.
Plan reference: `study/AI-OBSERVER-PARITY-IMPLEMENTATION-AND-VERIFICATION-PLAN.md`.

Every intentional difference between the Aaspai observer and the pinned
AI Observer reference must be listed here and approved. Items marked
`decision-required` are documented deviations awaiting a named owner.

## Storage

| # | Area | Reference | Aaspai | Classification | Status |
|---|---|---|---|---|---|
| S-1 | Central store | DuckDB file | SQLite (default runtime) with portable PostgreSQL DDL | acceptable | **deviation — SQLite-only runtime** |
| S-2 | PG migrations | DuckDB `CREATE OR REPLACE` | `packages/db/src/migrations-postgres.ts` executes the same DDL via postgres-js | acceptable | **decision-required** |
| S-3 | Tenant scope | single-user | org-scoped rows on every table incl. `telemetry_import_state` (org-scoped PK) | acceptable (stronger) | approved |
| S-4 | Dedup index | spans deduped by (ServiceName, TraceId, SpanId) | logs deduped by (org, dedup_key); spans by (org, trace_id, span_id) | acceptable (stronger) | approved |

Why S-1/S-2: the Aaspai repo's postgres runtime is still "Phase 4" for
all packages; `TelemetryRepository` requires the SQLite backend. The
telemetry DDL is written to be valid on both engines and the postgres
migration entry point exists (`runTelemetryPostgresMigrations`, OBS-T171
skipped until a postgres instance is reachable). Approved deviation
recorded in lieu of a live PG integration run.

## Ingestion

| # | Area | Reference | Aaspai | Classification | Status |
|---|---|---|---|---|---|
| I-1 | Codex `codex.sse_event` logs | dropped (noise filter) | dropped at OTLP conversion (`otlp.ts`) | match | approved |
| I-2 | OTLP body limit | 10 MB | 10 MB + Content-Length pre-check + per-org rate limit | acceptable (stronger) | approved |
| I-3 | Redaction | none central | redaction-before-persist on attributes + raw payloads | acceptable (stronger) | approved |
| I-4 | Idempotency | per-span dedupe; logs not deduped | content-hash dedup keys for OTLP logs; importer message-id pairs | acceptable | approved |
| I-5 | Cumulative→delta | OTLP metric delta derivation | not implemented (metrics stored as received); importers emit deltas for Codex | acceptable adaptation | **decision-required** |

## Watch / Import

| # | Area | Reference | Aaspai | Classification | Status |
|---|---|---|---|---|---|
| W-1 | Watcher | fsnotify + polling | node `fs.watch` + 30s polling fallback + debounce + byte-offset cursor | match | approved |
| W-2 | Path handling | configurable dirs | `AI_OBSERVER_*_PATH` env or default home dirs; org-scoped cursors | match | approved |
| W-3 | Quarantine | malformed-file quarantine | malformed records skipped; cursor persists; file marked error | acceptable | approved |

## API / Live

| # | Area | Reference | Aaspai | Classification | Status |
|---|---|---|---|---|---|
| A-1 | Live transport | WebSocket | SSE with `Last-Event-ID` replay from a persisted `telemetry_live_events` table | acceptable (plan §9.2 allows) | approved |
| A-2 | Web live path | WS from API | web `/api/observer/stream` polls the shared local DB (same store as CLI/worker) | acceptable for local single-store | **decision-required** |
| A-3 | Rate limiting | none | per-org token bucket on OTLP ingest | acceptable (stronger) | approved |

## Query / Cost

| # | Area | Reference | Aaspai | Classification | Status |
|---|---|---|---|---|---|
| Q-1 | Metric series aggregation | DuckDB `time_bucket` + arg_max | SQLite `strftime('%s')/interval` bucketing | acceptable | approved |
| Q-2 | Cost aggregation | per-metric series | allowlist of cost metric names, no rollup table | acceptable adaptation | **decision-required** |
| Q-3 | Cost recalculation | pricing versioned | pricing version stored in constants; recalculation not exposed | acceptable adaptation | **decision-required** |

## Verification

| # | Area | Reference | Aaspai | Classification | Status |
|---|---|---|---|---|---|
| V-1 | Differential harness | run reference binary | `scripts/observer-differential.ts` exports normalized comparison result; reference run requires Go toolchain (unavailable in this environment) | acceptable | **decision-required** |
| V-2 | Real provider runs | §12.6 | requires provider CLIs/credentials; substituted by pinned corpus + harness parity tests | acceptable | **decision-required** |
| V-3 | Browser verification | §12.5 | requires Playwright; substituted by `next build` + HTTP smoke of all observer pages | acceptable | **decision-required** |

## Known limitations (recorded, not fixed)

- `emitTranscriptMessages` bridge helper has no production callers (dead export).
- `nanosToIso` treats epoch-0 timestamps as missing (falls back to received time).
- Web observer pages have no loading/error boundaries or pagination UI yet.
- Import-state table shape changed in development; upgrades to the new
  org-scoped PK require dropping the derived `telemetry_import_state`
  table (safe: it is derived cursor state, recreated on next import).
