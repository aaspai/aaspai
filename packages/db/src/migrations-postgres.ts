import type { DbHandle } from "./connection.js";
import { TELEMETRY_MIGRATION_STATEMENTS } from "./migrations-telemetry.js";

/**
 * Postgres telemetry migrations.
 *
 * The telemetry DDL in `migrations-telemetry.ts` is written to be valid
 * on both SQLite and PostgreSQL (TEXT ids/timestamps, INTEGER booleans,
 * JSON stored as TEXT). When the configured backend is postgres, the
 * statements are executed through the postgres-js client.
 *
 * The rest of the repo's postgres path is still "Phase 4" (the legacy
 * `runMigrations` executes via the SQLite drizzle driver only); this
 * function is the observer's own durable, idempotent postgres path and
 * satisfies OBS-T171 once a postgres instance is reachable.
 */

export async function runTelemetryPostgresMigrations(handle: DbHandle): Promise<void> {
  if (handle.backend !== "postgres") {
    throw new Error("runTelemetryPostgresMigrations requires the postgres backend");
  }
  const sql = handle.raw as unknown as {
    unsafe(query: string): Promise<unknown>;
  };
  for (const statement of TELEMETRY_MIGRATION_STATEMENTS) {
    await sql.unsafe(statement);
  }
}
