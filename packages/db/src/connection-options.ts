export interface DatabaseConnectionOptions {
  max: number;
  connect_timeout: number;
  idle_timeout: number;
  max_lifetime: number;
}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

/**
 * Resolve bounded postgres.js pool settings from the environment.
 *
 * Tests intentionally use one connection: the suite serializes destructive
 * fixtures and sets a session-scoped audit cleanup guard on that connection.
 */
export function getDatabaseConnectionOptions(
  env: NodeJS.ProcessEnv = process.env,
): DatabaseConnectionOptions {
  const isTest = env.NODE_ENV === "test";
  return {
    max: boundedInteger(env.AASPAI_DB_POOL_MAX, isTest ? 1 : 10, 1, 100),
    connect_timeout: boundedInteger(env.AASPAI_DB_CONNECT_TIMEOUT_SECONDS, 10, 1, 60),
    idle_timeout: boundedInteger(env.AASPAI_DB_IDLE_TIMEOUT_SECONDS, isTest ? 0 : 30, 0, 3600),
    max_lifetime: boundedInteger(env.AASPAI_DB_MAX_LIFETIME_SECONDS, 1800, 60, 86400),
  };
}
