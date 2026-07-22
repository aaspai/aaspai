import { describe, expect, it } from "vitest";
import {
  idempotencyKeySchema,
  identifierSchema,
  isoTimestampSchema,
  jsonObjectSchema,
  jsonSchemaSchema,
  jsonValueSchema,
  MAX_JSON_DEPTH,
} from "../src/primitives";

describe("contract primitives", () => {
  it.each([null, true, "text", 42, ["nested", 1, false, null], { nested: { values: [1, 2, 3] } }])(
    "accepts JSON-safe value %#",
    (value) => {
      expect(jsonValueSchema.parse(value)).toEqual(value);
    },
  );

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, () => undefined, Symbol("x")])(
    "rejects non-JSON value %#",
    (value) => {
      expect(jsonValueSchema.safeParse(value).success).toBe(false);
    },
  );

  it("rejects non-plain and excessively deep JSON values", () => {
    const root: Record<string, unknown> = {};
    let cursor = root;
    for (let index = 0; index <= MAX_JSON_DEPTH; index += 1) {
      const child: Record<string, unknown> = {};
      cursor.child = child;
      cursor = child;
    }

    expect(jsonValueSchema.safeParse(new Date()).success).toBe(false);
    expect(jsonValueSchema.safeParse(root).success).toBe(false);
  });

  it("accepts object and boolean JSON schemas", () => {
    expect(jsonSchemaSchema.parse(true)).toBe(true);
    expect(jsonSchemaSchema.parse({ type: "object", additionalProperties: false })).toEqual({
      type: "object",
      additionalProperties: false,
    });
  });

  it("rejects arrays where a JSON object is required", () => {
    expect(jsonObjectSchema.safeParse([]).success).toBe(false);
  });

  it.each(["", "   "])("rejects blank identifier %j", (value) => {
    expect(identifierSchema.safeParse(value).success).toBe(false);
  });

  it.each(["", "   ", "2026-07-11", "not-a-date"])("rejects invalid timestamp %j", (value) => {
    expect(isoTimestampSchema.safeParse(value).success).toBe(false);
  });

  it("accepts offset-aware ISO timestamps", () => {
    expect(isoTimestampSchema.parse("2026-07-11T12:30:00+05:30")).toBe("2026-07-11T12:30:00+05:30");
  });

  it("bounds idempotency keys", () => {
    expect(idempotencyKeySchema.safeParse("key-1").success).toBe(true);
    expect(idempotencyKeySchema.safeParse("").success).toBe(false);
    expect(idempotencyKeySchema.safeParse("x".repeat(513)).success).toBe(false);
  });
});
