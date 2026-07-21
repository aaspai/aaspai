import { describe, expect, it } from "vitest";
import {
  createChildContext,
  createCorrelationContext,
  generateSpanId,
  generateTraceId,
  getCorrelationContext,
  setCorrelationContext,
} from "../src/tracing";

describe("generateTraceId", () => {
  it("generates a 32-char hex string", () => {
    const id = generateTraceId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("generateSpanId", () => {
  it("generates a 16-char hex string", () => {
    const id = generateSpanId();
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("createCorrelationContext", () => {
  it("creates context with trace and span IDs", () => {
    const ctx = createCorrelationContext({ organizationId: "org-1" });
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(ctx.correlationId).toBe(ctx.traceId);
    expect(ctx.organizationId).toBe("org-1");
  });

  it("accepts explicit correlationId", () => {
    const ctx = createCorrelationContext({ correlationId: "my-corr-id" });
    expect(ctx.correlationId).toBe("my-corr-id");
  });
});

describe("createChildContext", () => {
  it("inherits trace and correlation from parent", () => {
    const parent = createCorrelationContext({ organizationId: "org-1" });
    const child = createChildContext(parent);
    expect(child.traceId).toBe(parent.traceId);
    expect(child.causationId).toBe(parent.spanId);
    expect(child.spanId).not.toBe(parent.spanId);
  });
});

describe("set/get correlation context", () => {
  it("stores and retrieves context", () => {
    const ctx = createCorrelationContext();
    setCorrelationContext(ctx);
    const retrieved = getCorrelationContext();
    expect(retrieved).not.toBeNull();
    expect(retrieved!.traceId).toBe(ctx.traceId);
    setCorrelationContext(null);
  });

  it("returns previous context on set", () => {
    const ctx2 = createCorrelationContext();
    const prev = setCorrelationContext(ctx2);
    expect(prev).toBeNull();
    setCorrelationContext(null);
  });
});
