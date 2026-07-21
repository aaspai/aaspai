import { z } from "zod";

const DEFAULT_MAX_OBJECTS = 1_000;
const MAX_DURATION_MS = 2_147_483_647;
const LABEL = /^[A-Za-z0-9._-]{1,64}$/u;
const ISSUE_SEGMENT = /^[A-Za-z0-9_]{1,64}$/u;

export const environmentNameSchema = z.enum(["development", "test", "production"]);
export const logLevelSchema = z.enum(["trace", "debug", "info", "warn", "error", "fatal"]);
export const nonEmptyStringSchema = z.string().trim().min(1).max(4_096);
export const secretSchema = z.string().min(32).max(16_384);

function decimalIntegerSchema(minimum: number, maximum: number) {
  return z
    .string()
    .regex(/^(0|[1-9]\d*)$/u)
    .transform((value) => Number(value))
    .pipe(z.number().int().min(minimum).max(maximum));
}

export const portSchema = decimalIntegerSchema(1, 65_535);
export const durationMsSchema = decimalIntegerSchema(1, MAX_DURATION_MS);
export const booleanSchema = z.enum(["true", "false"]).transform((value) => value === "true");

export interface ConfigIssue {
  readonly path: string;
  readonly code: string;
}

export interface ConfigParseOptions {
  readonly label?: string;
  readonly maxObjects?: number;
}

export class ConfigValidationError extends Error {
  readonly code = "CONFIG_INVALID";
  readonly label: string;
  readonly issues: readonly Readonly<ConfigIssue>[];

  constructor(label: string, issues: readonly ConfigIssue[]) {
    super(
      `Invalid configuration for ${label} (${issues.length} issue${issues.length === 1 ? "" : "s"}).`,
    );
    this.name = "ConfigValidationError";
    this.label = label;
    this.issues = Object.freeze(issues.map((issue) => Object.freeze({ ...issue })));
  }
}

export class ConfigStructureError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ConfigStructureError";
    this.code = code;
  }
}

function normalizeLabel(label: string | undefined): string {
  if (label === undefined) return "runtime";
  if (!LABEL.test(label)) {
    throw new ConfigStructureError("CONFIG_LABEL_INVALID", "Configuration label is invalid.");
  }
  return label;
}

function isSupportedObject(value: object): boolean {
  if (Array.isArray(value)) return true;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeIssuePath(path: readonly PropertyKey[]): string {
  return path
    .map((segment) => {
      if (typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0) {
        return String(segment);
      }
      return typeof segment === "string" && ISSUE_SEGMENT.test(segment) ? segment : "?";
    })
    .join(".");
}

export function deepFreezeConfig<T>(
  value: T,
  options: Readonly<{ maxObjects?: number }> = {},
): Readonly<T> {
  const maximum = options.maxObjects ?? DEFAULT_MAX_OBJECTS;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > DEFAULT_MAX_OBJECTS) {
    throw new ConfigStructureError(
      "CONFIG_LIMIT_INVALID",
      "Configuration object limit is invalid.",
    );
  }
  if (value === null || typeof value !== "object") return value;

  const visited = new WeakSet<object>();
  const stack: object[] = [value];
  let count = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (visited.has(current)) {
      throw new ConfigStructureError(
        "CONFIG_CYCLE",
        "Configuration output must not contain cycles or aliases.",
      );
    }
    if (!isSupportedObject(current)) {
      throw new ConfigStructureError(
        "CONFIG_OBJECT_UNSUPPORTED",
        "Configuration output must contain only plain objects, arrays, and primitive values.",
      );
    }
    if (Object.getOwnPropertySymbols(current).length > 0) {
      throw new ConfigStructureError(
        "CONFIG_OBJECT_UNSUPPORTED",
        "Configuration output must not contain symbol properties.",
      );
    }
    visited.add(current);
    count += 1;
    if (count > maximum) {
      throw new ConfigStructureError(
        "CONFIG_TOO_COMPLEX",
        "Configuration output exceeds the object limit.",
      );
    }
    const descriptors = Object.getOwnPropertyDescriptors(current);
    for (const descriptor of Object.values(descriptors)) {
      if (descriptor.get || descriptor.set) {
        throw new ConfigStructureError(
          "CONFIG_OBJECT_UNSUPPORTED",
          "Configuration output must not contain accessor properties.",
        );
      }
      const child = descriptor.value;
      if (child !== null && typeof child === "object") stack.push(child);
    }
    Object.freeze(current);
  }
  return value;
}

export function parseConfig<Schema extends z.ZodType>(
  schema: Schema,
  source: unknown,
  options: ConfigParseOptions = {},
): Readonly<z.output<Schema>> {
  const label = normalizeLabel(options.label);
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: safeIssuePath(issue.path),
      code: issue.code,
    }));
    throw new ConfigValidationError(label, issues);
  }
  return deepFreezeConfig(result.data, { maxObjects: options.maxObjects });
}
