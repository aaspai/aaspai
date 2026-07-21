import type { AuthFailureCode } from "@aaspai/contracts";

const SAFE_MESSAGES: Readonly<Record<AuthFailureCode, string>> = Object.freeze({
  missing_credential: "Authentication required",
  malformed_credential: "Malformed authentication credential",
  invalid_credential: "Authentication failed",
  expired_credential: "Authentication credential expired",
  revoked_credential: "Authentication credential revoked",
  organization_denied: "Organization access denied",
  scope_denied: "Authentication scope denied",
  role_denied: "Authentication role denied",
});

/** Stable sanitized error for adapter and middleware boundaries. */
export class AuthVerificationError extends Error {
  readonly code: AuthFailureCode;

  constructor(code: AuthFailureCode) {
    super(SAFE_MESSAGES[code]);
    this.name = "AuthVerificationError";
    this.code = code;
  }
}

export function safeAuthMessage(code: AuthFailureCode): string {
  return SAFE_MESSAGES[code];
}
