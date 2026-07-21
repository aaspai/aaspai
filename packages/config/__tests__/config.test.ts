import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  booleanSchema,
  ConfigStructureError,
  ConfigValidationError,
  deepFreezeConfig,
  durationMsSchema,
  environmentNameSchema,
  logLevelSchema,
  nonEmptyStringSchema,
  parseConfig,
  portSchema,
  secretSchema,
} from "../src";

describe("configuration primitives", () => {
  it("accepts canonical environment and log levels", () => {
    expect(environmentNameSchema.parse("production")).toBe("production");
    expect(logLevelSchema.parse("warn")).toBe("warn");
    expect(environmentNameSchema.safeParse("prod").success).toBe(false);
  });

  it("coerces only canonical environment integers", () => {
    expect(portSchema.parse("3000")).toBe(3000);
    expect(durationMsSchema.parse("60000")).toBe(60_000);
    for (const value of ["0", "01", "-1", "1.5", "65536"]) {
      expect(portSchema.safeParse(value).success).toBe(false);
    }
  });

  it("coerces explicit lowercase booleans only", () => {
    expect(booleanSchema.parse("true")).toBe(true);
    expect(booleanSchema.parse("false")).toBe(false);
    expect(booleanSchema.safeParse("TRUE").success).toBe(false);
  });

  it("validates bounded non-empty values and secrets", () => {
    expect(nonEmptyStringSchema.parse(" value ")).toBe("value");
    expect(secretSchema.safeParse("short").success).toBe(false);
    expect(secretSchema.parse("s".repeat(32))).toHaveLength(32);
  });
});

describe("parseConfig", () => {
  const schema = z.strictObject({
    PORT: portSchema,
    ENABLED: booleanSchema,
    SECRET: secretSchema,
    NESTED: z.object({ value: nonEmptyStringSchema }),
  });

  it("parses an explicit source into deeply frozen typed output", () => {
    const source = {
      PORT: "8080",
      ENABLED: "true",
      SECRET: "x".repeat(32),
      NESTED: { value: "ok" },
    };
    const config = parseConfig(schema, source, { label: "worker" });
    expect(config.PORT).toBe(8080);
    expect(config.ENABLED).toBe(true);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.NESTED)).toBe(true);
    expect(source.PORT).toBe("8080");
  });

  it("rejects unknown keys through strict process schemas", () => {
    expect(() =>
      parseConfig(schema, {
        PORT: "8080",
        ENABLED: "true",
        SECRET: "x".repeat(32),
        NESTED: { value: "ok" },
        UNKNOWN: "no",
      }),
    ).toThrow(ConfigValidationError);
  });

  it("redacts rejected values and hostile schema messages", () => {
    const rejected = "do-not-leak-this-secret";
    const hostile = z.strictObject({
      SECRET: z.string().refine(() => false, { message: rejected }),
    });
    try {
      parseConfig(hostile, { SECRET: rejected }, { label: "web" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(JSON.stringify(error)).not.toContain(rejected);
      expect(String(error)).not.toContain(rejected);
      if (!(error instanceof ConfigValidationError)) throw error;
      expect(error.issues).toEqual([{ path: "SECRET", code: "custom" }]);
    }
  });

  it("sanitizes hostile source keys in issue paths", () => {
    const hostileKey = "do-not-leak.this";
    const recordSchema = z.record(z.string(), z.number());
    try {
      parseConfig(recordSchema, { [hostileKey]: "invalid" });
      expect.unreachable();
    } catch (error) {
      if (!(error instanceof ConfigValidationError)) throw error;
      expect(error.issues).toEqual([{ path: "?", code: "invalid_type" }]);
      expect(JSON.stringify(error)).not.toContain(hostileKey);
    }
  });

  it("rejects unsafe diagnostic labels", () => {
    expect(() => parseConfig(z.object({}), {}, { label: "secret\nvalue" })).toThrowError(
      expect.objectContaining({ code: "CONFIG_LABEL_INVALID" }),
    );
  });
});

describe("deepFreezeConfig", () => {
  it("rejects cycles and aliases", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => deepFreezeConfig(cyclic)).toThrowError(
      expect.objectContaining({ code: "CONFIG_CYCLE" }),
    );
    const shared = {};
    expect(() => deepFreezeConfig({ first: shared, second: shared })).toThrow(ConfigStructureError);
  });

  it("rejects unsupported objects and excessive graphs", () => {
    expect(() => deepFreezeConfig({ date: new Date() })).toThrowError(
      expect.objectContaining({ code: "CONFIG_OBJECT_UNSUPPORTED" }),
    );
    expect(() => deepFreezeConfig({ one: {}, two: {} }, { maxObjects: 2 })).toThrowError(
      expect.objectContaining({ code: "CONFIG_TOO_COMPLEX" }),
    );
    const accessor = Object.defineProperty({}, "value", { get: () => "secret", enumerable: true });
    expect(() => deepFreezeConfig(accessor)).toThrowError(
      expect.objectContaining({ code: "CONFIG_OBJECT_UNSUPPORTED" }),
    );
  });

  it("validates caller-supplied traversal limits", () => {
    expect(() => deepFreezeConfig({}, { maxObjects: 0 })).toThrowError(
      expect.objectContaining({ code: "CONFIG_LIMIT_INVALID" }),
    );
  });
});
