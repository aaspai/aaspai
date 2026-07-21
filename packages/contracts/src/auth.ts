import { z } from "zod";
import { identifierSchema } from "./primitives";

/**
 * Version of the identity payload exchanged between process boundaries.
 * Increment this only when the serialized shape changes incompatibly.
 */
export const AUTH_PROTOCOL_VERSION = 1 as const;

const boundedRoleSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._:-]+$/u);

const boundedIdentifierSchema = identifierSchema.max(256);

/** Scopes currently issued to personal access/API keys. */
export const apiScopeSchema = z.enum(["read", "read.history", "write", "deploy"]);
export type ApiScope = z.infer<typeof apiScopeSchema>;

export const authMethodSchema = z.enum(["session", "api_key", "service"]);
export type AuthMethod = z.infer<typeof authMethodSchema>;

const uniqueBoundedArray = <T extends z.ZodType>(item: T, max: number) =>
  z
    .array(item)
    .max(max)
    .refine((items) => new Set(items).size === items.length, {
      message: "Values must be unique",
    });

/**
 * Sanitized identity and authorization context. This is deliberately free of
 * cookies, raw bearer/session tokens, provider rows, and secret values.
 */
export const authPrincipalSchema = z
  .object({
    protocolVersion: z.literal(AUTH_PROTOCOL_VERSION),
    userId: boundedIdentifierSchema,
    organizationId: boundedIdentifierSchema,
    sessionId: boundedIdentifierSchema.optional(),
    apiKeyId: boundedIdentifierSchema.optional(),
    roles: uniqueBoundedArray(boundedRoleSchema, 32),
    scopes: uniqueBoundedArray(apiScopeSchema, 16),
    authMethod: authMethodSchema,
    // P1-Auth-2: set by the adapter only when authMethod === "session".
    // The middleware checks this flag to reject protected calls when
    // 2FA is enabled but the TOTP code has not been verified.
    twoFactorRedirect: z.boolean().optional(),
  })
  .strict()
  .superRefine((principal, context) => {
    if (principal.authMethod === "session" && !principal.sessionId) {
      context.addIssue({
        code: "custom",
        path: ["sessionId"],
        message: "Session identity is required",
      });
    }
    if (principal.authMethod === "api_key" && !principal.apiKeyId) {
      context.addIssue({
        code: "custom",
        path: ["apiKeyId"],
        message: "API key identity is required",
      });
    }
    if (principal.authMethod === "service" && (principal.sessionId || principal.apiKeyId)) {
      context.addIssue({
        code: "custom",
        path: ["authMethod"],
        message: "Service identity cannot carry session or API key identity",
      });
    }
    // C1: Prevent identity cross-contamination — a principal should
    // represent exactly one auth method's identity artifacts.
    if (principal.apiKeyId && principal.sessionId) {
      context.addIssue({
        code: "custom",
        path: [],
        message: "Principal cannot have both session and API key identity",
      });
    }
  });

export type AuthPrincipal = z.infer<typeof authPrincipalSchema>;

export const requestIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/u);

/** Sanitized request context made available to API route handlers. */
export const apiRequestContextSchema = z
  .object({
    protocolVersion: z.literal(AUTH_PROTOCOL_VERSION),
    requestId: requestIdSchema,
    principal: authPrincipalSchema,
  })
  .strict();

export type ApiRequestContext = z.infer<typeof apiRequestContextSchema>;

export const authFailureCodeSchema = z.enum([
  "missing_credential",
  "malformed_credential",
  "invalid_credential",
  "expired_credential",
  "revoked_credential",
  "organization_denied",
  "scope_denied",
  "role_denied",
]);
export type AuthFailureCode = z.infer<typeof authFailureCodeSchema>;

export const authVerificationSuccessSchema = z
  .object({ ok: z.literal(true), principal: authPrincipalSchema })
  .strict();

export const authVerificationFailureSchema = z
  .object({ ok: z.literal(false), code: authFailureCodeSchema })
  .strict();

export const authVerificationResultSchema = z.union([
  authVerificationSuccessSchema,
  authVerificationFailureSchema,
]);

export type AuthVerificationSuccess = z.infer<typeof authVerificationSuccessSchema>;
export type AuthVerificationFailure = z.infer<typeof authVerificationFailureSchema>;
export type AuthVerificationResult = z.infer<typeof authVerificationResultSchema>;
