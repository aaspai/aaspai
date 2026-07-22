/**
 * Dual-dialect connection factory.
 *
 * Foundation slice uses SQLite (zero-install, one file). Production
 * uses Postgres. The same Drizzle schema can target either; this
 * factory picks the right driver and connection based on the URL.
 *
 * Selection rules:
 *   - `AASPAI_DB=sqlite:<path>`        → SQLite via better-sqlite3
 *   - `AASPAI_DB=postgres://...`      → Postgres via postgres-js
 *   - `AASPAI_DB=postgresql://...`    → Postgres via postgres-js
 *   - `DATABASE_URL=...` (legacy)      → Postgres (back-compat)
 *   - default                          → `sqlite:./.aaspai/state.db`
 *
 * Migration is a one-time data move (CLI: `aaspai db migrate-sqlite-to-postgres`).
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type DbBackend = "sqlite" | "postgres";

/**
 * The DB handle's typed `db` field is the SQLite variant in the
 * foundation slice. Code that needs the dialect-narrowed db should
 * import `getDefaultSqliteDb` (foundation) or the full union (Phase 4).
 *
 * We keep the public `db` field as a structural object so consumers
 * can do method chains without TypeScript getting tangled in the
 * union of the two dialects (which is structurally identical but
 * nominally different).
 */
export type SqliteDb = ReturnType<typeof drizzleSqlite<typeof schema>>;

export interface DbHandle {
  db: SqliteDb;
  backend: DbBackend;
  raw: Database.Database | ReturnType<typeof postgres>;
  close(): Promise<void>;
}

function resolveUrl(): string {
  return process.env.AASPAI_DB ?? process.env.DATABASE_URL ?? "sqlite:./.aaspai/state.db";
}

export function detectBackend(url: string): DbBackend {
  if (url.startsWith("sqlite:")) return "sqlite";
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) return "postgres";
  throw new Error(`Unsupported AASPAI_DB URL: ${url}`);
}

export function createDb(): DbHandle {
  const url = resolveUrl();
  const backend = detectBackend(url);

  if (backend === "sqlite") {
    const path = url.slice("sqlite:".length);
    // Ensure the parent directory exists (SQLite won't create it for us).
    mkdirSync(dirname(path), { recursive: true });
    const sqlite = new Database(path);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    const db = drizzleSqlite(sqlite, { schema });
    return {
      db,
      backend: "sqlite",
      raw: sqlite,
      async close() {
        sqlite.close();
      },
    };
  }

  // Postgres branch (Phase 4) — we still return a SqliteDb-typed handle
  // because consumers in the foundation slice don't talk to it.
  const client = postgres(url, { max: 10 });
  const db = drizzlePostgres(client, { schema }) as unknown as SqliteDb;
  return {
    db,
    backend: "postgres",
    raw: client,
    async close() {
      await client.end({ timeout: 5 });
    },
  };
}

let _default: DbHandle | null = null;
export function getDefaultDb(): DbHandle {
  if (!_default) _default = createDb();
  return _default;
}

export async function closeDefaultDb(): Promise<void> {
  if (_default) {
    await _default.close();
    _default = null;
  }
}
