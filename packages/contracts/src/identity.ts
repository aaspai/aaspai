import { z } from "zod";
import { identifierSchema, isoTimestampSchema } from "./primitives";

/**
 * Version of the identity contract exchanged between packages.
 */
export const IDENTITY_PROTOCOL_VERSION = 1 as const;

/**
 * Actor types in the AASPAI actor model — humans, AI agents,
 * service accounts, external systems, and teams.
 */
export const actorTypeSchema = z.enum(["human", "agent", "service", "system", "team"]);
export type ActorType = z.infer<typeof actorTypeSchema>;

const boundedIdentifierSchema = identifierSchema.max(256);
const boundedLabelSchema = z.string().trim().min(1).max(128);

/**
 * An actor that can perform actions within the system.
 *
 * This is the base identity primitive — every authenticated caller,
 * whether a human user, an AI agent, or a service integration,
 * resolves to an Actor.
 */
export const actorSchema = z
  .object({
    protocolVersion: z.literal(IDENTITY_PROTOCOL_VERSION),
    id: boundedIdentifierSchema,
    type: actorTypeSchema,
    displayName: boundedLabelSchema.optional(),
    organizationId: boundedIdentifierSchema,
    createdAt: isoTimestampSchema,
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type Actor = z.infer<typeof actorSchema>;

/**
 * Credential kind used to authenticate — session cookie, bearer
 * token, HMAC signature, or client certificate.
 */
export const credentialKindSchema = z.enum(["session", "bearer", "hmac", "certificate"]);
export type CredentialKind = z.infer<typeof credentialKindSchema>;

/**
 * Outcome of an identity verification attempt.
 */
export const identityVerificationResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), actor: actorSchema }).strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.enum([
        "missing_credential",
        "malformed_credential",
        "invalid_credential",
        "expired_credential",
        "revoked_credential",
        "organization_denied",
      ]),
    })
    .strict(),
]);
export type IdentityVerificationResult = z.infer<typeof identityVerificationResultSchema>;

/**
 * Input to an identity verification call. Credential value is never
 * part of any result or log output.
 */
export const identityVerifyInputSchema = z
  .object({
    credential: z
      .object({
        kind: credentialKindSchema,
        value: z.string().min(1).max(16_384),
      })
      .optional(),
    organizationId: boundedIdentifierSchema.optional(),
  })
  .strict();
export type IdentityVerifyInput = z.infer<typeof identityVerifyInputSchema>;

/**
 * A resolved identity with authorization context — which Actor,
 * their roles, and granted scopes within an organization.
 */
export const resolvedIdentitySchema = z
  .object({
    protocolVersion: z.literal(IDENTITY_PROTOCOL_VERSION),
    actor: actorSchema,
    sessionId: boundedIdentifierSchema.optional(),
    apiKeyId: boundedIdentifierSchema.optional(),
    roles: z.array(z.string().trim().min(1).max(64)).max(32),
    scopes: z.array(z.string().trim().min(1).max(64)).max(16),
  })
  .strict();
export type ResolvedIdentity = z.infer<typeof resolvedIdentitySchema>;

/**
 * API key identity and scope configuration.
 */
export const apiKeyConfigSchema = z
  .object({
    prefix: z.string().trim().min(1).max(32),
    minLength: z.number().int().min(16).max(128),
    hashAlgorithm: z.enum(["sha256"]),
    maxScopes: z.number().int().min(1).max(64),
  })
  .strict();
export type ApiKeyConfig = z.infer<typeof apiKeyConfigSchema>;

export const DEFAULT_API_KEY_CONFIG: ApiKeyConfig = Object.freeze({
  prefix: "aaspai_pat_",
  minLength: 32,
  hashAlgorithm: "sha256",
  maxScopes: 16,
});

/**
 * Result of generating a new API key. The plain value is shown
 * exactly once; the hash is persisted for verification.
 */
export const apiKeyGenerateResultSchema = z
  .object({
    plain: z.string().min(32).max(256),
    hash: z.string().min(32).max(128),
    id: boundedIdentifierSchema,
  })
  .strict();
export type ApiKeyGenerateResult = z.infer<typeof apiKeyGenerateResultSchema>;

/**
 * Lookup result for an API key verification. Provides just enough
 * context for authorization without exposing the full credential.
 */
export const apiKeyIdentitySchema = z
  .object({
    apiKeyId: boundedIdentifierSchema,
    userId: boundedIdentifierSchema,
    organizationId: boundedIdentifierSchema,
    scopes: z.array(z.string()).max(16),
    roles: z.array(z.string()).max(32).optional(),
  })
  .strict();
export type ApiKeyIdentity = z.infer<typeof apiKeyIdentitySchema>;

/**
 * Lockout policy configuration for login attempts.
 */
export const lockoutPolicySchema = z
  .object({
    failThreshold: z.number().int().min(1).max(100),
    failWindowMs: z.number().int().min(1_000).max(3_600_000),
    lockoutDurationMs: z.number().int().min(1_000).max(86_400_000),
  })
  .strict();
export type LockoutPolicy = z.infer<typeof lockoutPolicySchema>;

export const DEFAULT_LOCKOUT_POLICY: LockoutPolicy = Object.freeze({
  failThreshold: 5,
  failWindowMs: 900_000,
  lockoutDurationMs: 1_800_000,
});

/**
 * Result of a lockout check.
 */
export const lockoutCheckResultSchema = z
  .object({
    locked: z.boolean(),
    retryAfterSec: z.number().int().nonnegative(),
  })
  .strict();
export type LockoutCheckResult = z.infer<typeof lockoutCheckResultSchema>;

/**
 * Session authorization context — org membership, roles, scopes.
 */
export const sessionAuthorizationSchema = z
  .object({
    organizationId: boundedIdentifierSchema.optional(),
    roles: z.array(z.string()).max(32).optional(),
    scopes: z.array(z.string()).max(16).optional(),
  })
  .strict();
export type SessionAuthorization = z.infer<typeof sessionAuthorizationSchema>;
