/**
 * Identity error codes — stable, context-free identifiers for
 * authentication and authorization failures.
 */
export type IdentityErrorCode =
  | "missing_credential"
  | "malformed_credential"
  | "invalid_credential"
  | "expired_credential"
  | "revoked_credential"
  | "organization_denied"
  | "scope_denied"
  | "role_denied";

const SAFE_MESSAGES: Readonly<Record<IdentityErrorCode, string>> = Object.freeze({
  missing_credential: "Authentication required",
  malformed_credential: "Malformed authentication credential",
  invalid_credential: "Authentication failed",
  expired_credential: "Authentication credential expired",
  revoked_credential: "Authentication credential revoked",
  organization_denied: "Organization access denied",
  scope_denied: "Scope denied",
  role_denied: "Role denied",
});

/**
 * Stable sanitized error for adapter and middleware boundaries.
 * The message is safe to return to callers — no internal context
 * is leaked.
 */
export class IdentityError extends Error {
  readonly code: IdentityErrorCode;

  constructor(code: IdentityErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = "IdentityError";
    this.code = code;
  }
}

/**
 * Get a safe, user-facing message for an error code. Never returns
 * internal context, secrets, or stack traces.
 */
export function safeIdentityMessage(code: IdentityErrorCode): string {
  return SAFE_MESSAGES[code];
}
