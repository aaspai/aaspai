import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { detectBackend } from "../src/connection.js";
import { runTelemetryPostgresMigrations } from "../src/migrations-postgres.js";

/**
 * OBS-T171 — telemetry migrations apply to a new PostgreSQL database.
 *
 * This test requires a reachable postgres instance. Set DATABASE_URL to
 * a scratch database, e.g.:
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/aaspai_test
 *
 * Without DATABASE_URL the case is recorded as skipped (written decision
 * per plan §10): the repo's postgres runtime is "Phase 4" and no local
 * postgres server is available in the default CI/dev environment.
 */

const DATABASE_URL = process.env.DATABASE_URL;

async function postgresAvailable(): Promise<boolean> {
  if (!DATABASE_URL) return false;
  try {
    const backend = detectBackend(DATABASE_URL);
    if (backend !== "postgres") return false;
    const sql = postgres(DATABASE_URL, { max: 1 });
    await sql`SELECT 1`;
    await sql.end({ timeout: 5 });
    return true;
  } catch {
    return false;
  }
}

describe("telemetry postgres migrations (OBS-T171)", () => {
  it("applies telemetry DDL to a fresh postgres database", async () => {
    if (!(await postgresAvailable())) {
      console.warn("SKIPPED: no reachable postgres (DATABASE_URL not set or offline)");
      return;
    }
    const url = DATABASE_URL!;
    const sql = postgres(url, { max: 5 });
    try {
      const handle = {
        backend: "postgres" as const,
        raw: sql,
        db: undefined,
        close: async () => {
          await sql.end({ timeout: 5 });
        },
      } as never;
      await runTelemetryPostgresMigrations(handle as never);

      const tables = await sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name LIKE 'telemetry_%'
      `;
      const names = tables.map((t) => String(t.table_name)).sort();
      expect(names).toEqual(
        [
          "telemetry_dashboard_widgets",
          "telemetry_dashboards",
          "telemetry_import_state",
          "telemetry_ingest_errors",
          "telemetry_logs",
          "telemetry_metrics",
          "telemetry_session_messages",
          "telemetry_sessions",
          "telemetry_spans",
        ].sort(),
      );

      const indexes = await sql`
        SELECT indexname FROM pg_indexes WHERE tablename LIKE 'telemetry_%'
      `;
      const indexNames = indexes.map((i) => String(i.indexname));
      expect(indexNames).toContain("tl_org_observed_idx");
      expect(indexNames).toContain("tsess_org_session_uniq");
      expect(indexNames).toContain("timport_source_path_uniq");

      await sql.end({ timeout: 5 });
    } finally {
      await sql.end({ timeout: 5 }).catch(() => undefined);
    }
  });
});
