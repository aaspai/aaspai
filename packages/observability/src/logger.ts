import type { LogLevel } from "@aaspai/contracts/observability";

export type { LogLevel };

/** Contextual fields that can be attached to a log entry. */
export interface LogContext {
  module?: string;
  [key: string]: unknown;
}

/**
 * Structured logger interface.
 *
 * Every log entry includes timestamp, level, message, and optional
 * structured context. Sensitive values must be scrubbed before
 * being passed to any logger method.
 */
export interface Logger {
  trace(msg: string, ctx?: LogContext): void;
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  fatal(msg: string, ctx?: LogContext): void;
  /** Create a child logger with bound context fields. */
  child(bindings: LogContext): Logger;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

function readMinLevel(): number {
  const env = process.env.AASPAI_LOG_LEVEL;
  if (env && env in LEVEL_RANK) return LEVEL_RANK[env as LogLevel];
  return process.env.NODE_ENV === "production" ? LEVEL_RANK.info : LEVEL_RANK.debug;
}

const MIN_LEVEL = readMinLevel();
let runtimeMinLevel: number | null = null;

function emit(level: LogLevel, bindings: LogContext, msg: string, ctx?: LogContext): void {
  const min = runtimeMinLevel ?? MIN_LEVEL;
  if (LEVEL_RANK[level] < min) return;
  const record: Record<string, unknown> = {
    t: new Date().toISOString(),
    level,
    msg,
    ...bindings,
    ...(ctx ?? {}),
  };
  const line = JSON.stringify(record);
  if (level === "error" || level === "fatal") {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

function makeLogger(bindings: LogContext): Logger {
  return {
    trace: (msg, ctx) => emit("trace", bindings, msg, ctx),
    debug: (msg, ctx) => emit("debug", bindings, msg, ctx),
    info: (msg, ctx) => emit("info", bindings, msg, ctx),
    warn: (msg, ctx) => emit("warn", bindings, msg, ctx),
    error: (msg, ctx) => emit("error", bindings, msg, ctx),
    fatal: (msg, ctx) => emit("fatal", bindings, msg, ctx),
    child: (extra) => makeLogger({ ...bindings, ...extra }),
  };
}

/** Root process-wide logger with no module binding. */
export const rootLogger = makeLogger({});

/**
 * Get a logger scoped to a module.
 *
 * ```ts
 * import { getLogger } from "@aaspai/observability";
 * const log = getLogger("runner");
 * log.info("deploy started", { deploymentId: "abc" });
 * ```
 */
export function getLogger(moduleName: string): Logger {
  return makeLogger({ module: moduleName });
}

/**
 * Update the minimum log level at runtime. Pass `null` to revert
 * to the env-derived default.
 */
export function setMinLevel(level: LogLevel | null): void {
  runtimeMinLevel = level === null ? null : LEVEL_RANK[level];
}

export const LEVELS = Object.freeze(
  Object.fromEntries(Object.entries(LEVEL_RANK)) as Record<LogLevel, number>,
);
