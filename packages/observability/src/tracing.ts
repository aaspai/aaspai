import { createHash, randomBytes } from "node:crypto";

/**
 * A trace ID — 32 hex characters (128-bit).
 */
export function generateTraceId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * A span ID — 16 hex characters (64-bit).
 */
export function generateSpanId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Propagate correlation context across async boundaries.
 * Each context includes a trace ID for distributed tracing,
 * a correlation ID for business operation tracking, and
 * optional causation for causality chains.
 */
export interface CorrelationContext {
  traceId: string;
  spanId: string;
  correlationId: string;
  causationId?: string;
  organizationId?: string;
  actorId?: string;
}

const CONTEXT_SYMBOL = Symbol.for("aaspai:correlationContext");

type GlobalWithSymbol = typeof globalThis & Record<symbol, unknown>;

/**
 * Get the current correlation context from async storage.
 * Returns null if no context has been set.
 */
export function getCorrelationContext(): CorrelationContext | null {
  return (globalThis as GlobalWithSymbol)[CONTEXT_SYMBOL] as CorrelationContext | null;
}

/**
 * Set the current correlation context for the remainder of the
 * async execution. Returns the previous context so callers can
 * restore it.
 */
export function setCorrelationContext(
  context: CorrelationContext | null,
): CorrelationContext | null {
  const prev = getCorrelationContext();
  (globalThis as GlobalWithSymbol)[CONTEXT_SYMBOL] = context;
  return prev;
}

/**
 * Create a new correlation context, optionally inheriting from
 * an existing one.
 */
export function createCorrelationContext(overrides?: {
  correlationId?: string;
  causationId?: string;
  organizationId?: string;
  actorId?: string;
}): CorrelationContext {
  const traceId = generateTraceId();
  const spanId = generateSpanId();
  return {
    traceId,
    spanId,
    correlationId: overrides?.correlationId ?? traceId,
    causationId: overrides?.causationId,
    organizationId: overrides?.organizationId,
    actorId: overrides?.actorId,
  };
}

/**
 * Create a child correlation context for a downstream operation.
 * Inherits the parent trace and correlation IDs but generates a
 * new span ID and sets the parent span as causation.
 */
export function createChildContext(
  parent: CorrelationContext,
  overrides?: {
    correlationId?: string;
    organizationId?: string;
    actorId?: string;
  },
): CorrelationContext {
  return {
    traceId: parent.traceId,
    spanId: generateSpanId(),
    correlationId: overrides?.correlationId ?? parent.correlationId,
    causationId: parent.spanId,
    organizationId: overrides?.organizationId ?? parent.organizationId,
    actorId: overrides?.actorId ?? parent.actorId,
  };
}

/**
 * Hash-free stable correlation ID from a key string.
 */
export function correlationIdFromKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}
