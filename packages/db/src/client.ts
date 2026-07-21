import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getDatabaseConnectionOptions } from "./connection-options";
import * as schema from "./schema";

/**
 * Resolve the Postgres connection URL.
 *
 * Resolution order (top wins):
 *   1. `process.env.DATABASE_URL` — set explicitly by the operator
 *      (e.g. in production systemd unit, in .env.local for the host
 *      dev server, in the docker-compose `environment:` block for
 *      the dev container).
 *   2. Default based on runtime context supplied by the owning process:
 *      - container: postgres://aaspai:aaspai@aaspai-postgres:5432/aaspai
 *      - host:      postgres://aaspai:aaspai@localhost:5432/aaspai
 *
 * The container default is correct for our docker-compose.dev.yml
 * (postgres:5432) and for the dev container (also postgres:5432).
 * The host default is correct when a developer runs the dev server
 * directly on their Linux/macOS box against a locally-installed
 * Postgres or a Postgres container exposed on localhost:5432.
 *
 * Operators running in unusual topologies (remote DB, RDS, etc.)
 * should always set DATABASE_URL explicitly.
 */
function resolveDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  // Keep the persistence package independent from process runtimes. Instead, use a minimal
  // detection: if /.dockerenv exists or /proc/1/cgroup mentions
  // docker, we're in a container.
  let inContainer = false;
  try {
    // biome-ignore: require is fine in this conditional
    inContainer = !!require("node:fs").existsSync("/.dockerenv");
  } catch {
    // not Linux
  }
  if (!inContainer) {
    try {
      const cgroup = require("node:fs").readFileSync("/proc/1/cgroup", "utf8");
      if (/docker|containerd|kubepods|lxc/.test(cgroup)) inContainer = true;
    } catch {
      // not Linux
    }
  }
  return inContainer
    ? "postgres://aaspai:aaspai@aaspai-postgres:5432/aaspai"
    : "postgres://aaspai:aaspai@localhost:5432/aaspai";
}

const databaseUrl = resolveDatabaseUrl();

// postgres-js returns a singleton pool. Operator-provided values are bounded
// so a typo cannot create thousands of connections or an unbounded outage wait.
const queryClient = postgres(databaseUrl, getDatabaseConnectionOptions());

export const db = drizzle(queryClient, { schema });
export type Database = typeof db;
export { schema };

/** Bounded, read-only connectivity probe for independently running services. */
export async function pingDatabase(): Promise<boolean> {
  try {
    await queryClient`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export async function closeDatabase(timeoutSeconds = 5): Promise<void> {
  await queryClient.end({ timeout: timeoutSeconds });
}
