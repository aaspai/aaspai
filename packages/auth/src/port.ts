import type {
  ApiScope,
  AuthFailureCode,
  AuthPrincipal,
  AuthVerificationResult,
} from "@aaspai/contracts";
import { hasScope } from "./scopes";

/** Process-local input. The credential value is never part of a DTO/result. */
export interface AuthVerifyInput {
  credential?: {
    kind: "bearer" | "session";
    value: string;
  };
}

/** API-owned authentication/session verification port. */
export interface AuthVerifier {
  verify(input: AuthVerifyInput): Promise<AuthVerificationResult>;
}

export interface PrincipalAuthorizationRequirements {
  organizationId?: string;
  requiredScopes?: readonly ApiScope[];
  requiredRoles?: readonly string[];
}

export type PrincipalAuthorizationResult =
  | { ok: true; principal: AuthPrincipal }
  | {
      ok: false;
      code: Extract<AuthFailureCode, "organization_denied" | "scope_denied" | "role_denied">;
    };

/**
 * Applies route-level organization, scope, and role checks to a verified
 * principal. It intentionally returns no reason text that could leak context.
 */
export function authorizePrincipal(
  principal: AuthPrincipal,
  requirements: PrincipalAuthorizationRequirements,
): PrincipalAuthorizationResult {
  if (requirements.organizationId && principal.organizationId !== requirements.organizationId) {
    return { ok: false, code: "organization_denied" };
  }

  if (
    requirements.requiredScopes?.some((required) => !hasScope(principal.scopes, required)) ??
    false
  ) {
    return { ok: false, code: "scope_denied" };
  }

  if (
    requirements.requiredRoles?.some((required) => !principal.roles.includes(required)) ??
    false
  ) {
    return { ok: false, code: "role_denied" };
  }

  return { ok: true, principal };
}

// B2: Canonical `hasScope` lives in `./scopes`. Re-export so existing
// consumers of `@aaspai/auth` continue to import from the same path.
export { hasScope } from "./scopes";
