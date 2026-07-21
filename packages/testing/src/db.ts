import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

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
        /* keep walking */
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
 * Load repo-root test env files before any test imports.
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

/**
 * Assert that the DATABASE_URL points to a test database.
 */
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

/**
 * Bound database setup timeout.
 */
export function testDatabaseConnectTimeoutSeconds(
  raw = process.env.AASPAI_TEST_DB_CONNECT_TIMEOUT_SECONDS,
): number {
  if (raw === undefined || raw.trim() === "") return 5;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 30 ? parsed : 5;
}
