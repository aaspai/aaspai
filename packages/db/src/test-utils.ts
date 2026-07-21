import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { type Database, db } from "./client";
import { organization } from "./schema/organizations";

const TEST_DB_NAME_RE = /(^|[_-])test($|[_-])|^test[_-]?/i;

function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 16; i++) {
    const pkg = path.join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const txt = readFileSync(pkg, "utf8");
        if (txt.includes('"workspaces"')) return dir;
      } catch {
        // Keep walking.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadEnvFile(file: string): void {
  const text = readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = unquoteEnvValue(trimmed.slice(eq + 1));
  }
}

/**
 * Load repo-root test env files before any test imports @aaspai/db/client.
 */
export function loadTestEnv(start = process.cwd()): void {
  const repoRoot = findRepoRoot(start);
  const candidates = [
    ".env.test",
    ".env.local",
    ".env",
    path.join("apps", "web", ".env.test"),
    path.join("apps", "web", ".env.local"),
    path.join("apps", "web", ".env"),
  ];
  for (const candidate of candidates) {
    const file = path.isAbsolute(candidate) ? candidate : path.join(repoRoot, candidate);
    if (existsSync(file)) loadEnvFile(file);
  }

  if (!existsSync("/.dockerenv") && process.env.DATABASE_URL?.includes("@postgres:")) {
    process.env.DATABASE_URL = process.env.DATABASE_URL.replace("@postgres:", "@localhost:");
  }
}

export function assertTestDatabaseUrl(
  raw = process.env.DATABASE_URL,
  context = "test database cleanup",
): string {
  if (!raw) {
    throw new Error(`${context}: DATABASE_URL is not set`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${context}: DATABASE_URL is not a valid URL`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`${context}: DATABASE_URL must use postgres/postgresql`);
  }
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!dbName) {
    throw new Error(`${context}: DATABASE_URL has no database name`);
  }
  if (process.env.AASPAI_ALLOW_TEST_TRUNCATE === "1") {
    return dbName;
  }
  if (!TEST_DB_NAME_RE.test(dbName)) {
    throw new Error(
      `${context}: refusing destructive test cleanup against non-test database ${JSON.stringify(
        dbName,
      )}. Use a database name containing "test" or set AASPAI_ALLOW_TEST_TRUNCATE=1 explicitly.`,
    );
  }
  return dbName;
}

/** Bound database setup failures so a dead Docker bridge cannot stall CI. */
export function testDatabaseConnectTimeoutSeconds(
  raw = process.env.AASPAI_TEST_DB_CONNECT_TIMEOUT_SECONDS,
): number {
  if (raw === undefined || raw.trim() === "") return 5;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 30 ? parsed : 5;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export async function ensureTestDatabaseExists(raw = process.env.DATABASE_URL): Promise<void> {
  const dbName = assertTestDatabaseUrl(raw, "ensureTestDatabaseExists");
  if (!raw) return;
  const admin = new URL(raw);
  admin.pathname = `/${process.env.AASPAI_TEST_ADMIN_DATABASE ?? "postgres"}`;

  const connectTimeout = testDatabaseConnectTimeoutSeconds();
  const clientOptions = {
    max: 1,
    connect_timeout: connectTimeout,
    idle_timeout: connectTimeout,
  } as const;

  const sql = postgres(admin.toString(), clientOptions);
  try {
    const existing = await sql<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${dbName}) AS "exists"
    `;
    if (!existing[0]?.exists) {
      await sql.unsafe(`CREATE DATABASE ${quoteIdentifier(dbName)}`);
    }
  } finally {
    await sql.end();
  }

  const testSql = postgres(raw, clientOptions);
  try {
    const db = drizzle(testSql);
    const here = path.dirname(fileURLToPath(import.meta.url));
    const migrationsFolder = path.resolve(here, "../migrations");
    await migrate(db, { migrationsFolder });
  } finally {
    await testSql.end();
  }
}

export async function insertTestOrganization(
  input: Readonly<{ id: string; name: string; slug: string }>,
  database: Database = db,
): Promise<void> {
  assertTestDatabaseUrl(process.env.DATABASE_URL, "insertTestOrganization");
  await database.insert(organization).values(input);
}

export async function deleteTestOrganization(
  organizationId: string,
  database: Database = db,
): Promise<void> {
  assertTestDatabaseUrl(process.env.DATABASE_URL, "deleteTestOrganization");
  await database.delete(organization).where(eq(organization.id, organizationId));
}
