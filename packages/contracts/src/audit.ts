import { z } from "zod";
import { identifierSchema, isoTimestampSchema, jsonObjectSchema } from "./primitives";

/**
 * Version of the audit event contract.
 */
export const AUDIT_PROTOCOL_VERSION = 1 as const;

const boundedIdentifierSchema = identifierSchema.max(256);
const boundedActionSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/u);
const boundedTargetTypeSchema = z.string().trim().min(1).max(64);

/**
 * IPv4 or IPv6 address validation regex.
 */
const ipv4Regex = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/u;
const ipv6Regex = /^[0-9a-f:]+(?:%[\w.]+)?$/iu;
const boundedIpSchema = z
  .string()
  .trim()
  .max(64)
  .refine((val) => ipv4Regex.test(val) || ipv6Regex.test(val), {
    message: "Must be a valid IPv4 or IPv6 address",
  })
  .optional();
const boundedUserAgentSchema = z.string().trim().max(512).optional();
const correlationIdSchema = boundedIdentifierSchema;

/**
 * An immutable audit event recording a business action.
 *
 * Audit events are append-only — once written they must never be
 * modified or deleted (enforced by the store adapter).
 */
export const auditEventSchema = z
  .object({
    protocolVersion: z.literal(AUDIT_PROTOCOL_VERSION),
    id: boundedIdentifierSchema,
    organizationId: boundedIdentifierSchema,
    correlationId: correlationIdSchema,
    causationId: boundedIdentifierSchema.optional(),
    actorId: boundedIdentifierSchema,
    action: boundedActionSchema,
    targetType: boundedTargetTypeSchema,
    targetId: boundedIdentifierSchema.optional(),
    occurredAt: isoTimestampSchema,
    recordedAt: isoTimestampSchema,
    metadata: jsonObjectSchema.optional(),
    ip: boundedIpSchema,
    userAgent: boundedUserAgentSchema,
  })
  .strict();

export type AuditEvent = z.infer<typeof auditEventSchema>;

/**
 * Immutable identity for an audit event — derived from the
 * event's correlation ID and sequence number.
 */
export const auditEventIdSchema = boundedIdentifierSchema;
export type AuditEventId = z.infer<typeof auditEventIdSchema>;

/**
 * Filter parameters for querying audit events.
 */
export const auditQuerySchema = z
  .object({
    organizationId: boundedIdentifierSchema,
    actionPrefix: boundedActionSchema.optional(),
    targetType: boundedTargetTypeSchema.optional(),
    targetId: boundedIdentifierSchema.optional(),
    actorId: boundedIdentifierSchema.optional(),
    correlationId: correlationIdSchema.optional(),
    from: isoTimestampSchema.optional(),
    to: isoTimestampSchema.optional(),
    limit: z.number().int().min(1).max(1_000).default(100),
    offset: z.number().int().nonnegative().default(0),
    order: z.enum(["asc", "desc"]).default("desc"),
  })
  .strict()
  .superRefine((query, context) => {
    if (query.from && query.to && Date.parse(query.to) < Date.parse(query.from)) {
      context.addIssue({
        code: "custom",
        message: "Query 'to' timestamp must follow 'from' timestamp",
        path: ["to"],
      });
    }
  });

export type AuditQuery = z.infer<typeof auditQuerySchema>;

/**
 * Result of counting audit events for a query.
 */
export const auditCountResultSchema = z
  .object({
    total: z.number().int().nonnegative(),
  })
  .strict();
export type AuditCountResult = z.infer<typeof auditCountResultSchema>;

/**
 * Retention configuration for pruning audit events.
 */
export const auditRetentionConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxAgeDays: z.number().int().min(1).max(3_650).default(365),
    batchSize: z.number().int().min(10).max(10_000).default(1_000),
  })
  .strict();
export type AuditRetentionConfig = z.infer<typeof auditRetentionConfigSchema>;

export const DEFAULT_AUDIT_RETENTION_CONFIG: AuditRetentionConfig = Object.freeze({
  enabled: true,
  maxAgeDays: 365,
  batchSize: 1_000,
});
