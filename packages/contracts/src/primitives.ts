import { z } from "zod";

export const CONTRACT_PROTOCOL_VERSION = 1 as const;

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type JsonSchema = boolean | JsonObject;

export const MAX_JSON_DEPTH = 64;
export const MAX_JSON_NODES = 100_000;

export const identifierSchema = z.string().trim().min(1);
export const correlationIdSchema = identifierSchema;
export const idempotencyKeySchema = z.string().trim().min(1).max(512);
export const positiveIntegerSchema = z.number().int().positive();
export const nonNegativeIntegerSchema = z.number().int().nonnegative();
export const isoTimestampSchema = z.iso.datetime({ offset: true });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isBoundedJsonValue(input: unknown): input is JsonValue {
  const pending: Array<{ depth: number; value: unknown }> = [{ depth: 0, value: input }];
  let visitedNodes = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) return false;
    visitedNodes += 1;
    if (visitedNodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) return false;

    const { value } = current;
    if (value === null || typeof value === "string" || typeof value === "boolean") continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return false;
      continue;
    }

    const nextDepth = current.depth + 1;
    if (Array.isArray(value)) {
      for (const item of value) pending.push({ depth: nextDepth, value: item });
      continue;
    }
    if (isPlainObject(value)) {
      for (const item of Object.values(value)) pending.push({ depth: nextDepth, value: item });
      continue;
    }
    return false;
  }

  return true;
}

export const jsonValueSchema = z.custom<JsonValue>(isBoundedJsonValue, {
  message: "Expected bounded JSON-safe data",
});

export const jsonObjectSchema = z.custom<JsonObject>(
  (value) => isPlainObject(value) && isBoundedJsonValue(value),
  { message: "Expected a bounded JSON object" },
);
export const jsonSchemaSchema: z.ZodType<JsonSchema> = z.union([z.boolean(), jsonObjectSchema]);

export const organizationScopedSchema = z
  .object({
    organizationId: identifierSchema,
  })
  .strict();

export type OrganizationScoped = z.infer<typeof organizationScopedSchema>;
