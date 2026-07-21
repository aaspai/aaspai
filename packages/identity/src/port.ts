import type { Actor, IdentityVerificationResult, IdentityVerifyInput } from "@aaspai/contracts";
import type { IdentityErrorCode } from "./errors";

/**
 * Input to identity verification — wraps the credential and
 * optional organization scope. Credential value is never part
 * of any result or log output.
 */
export type { IdentityVerifyInput };

/**
 * Identity verification port. Implementations verify credentials
 * (session cookies, bearer tokens, HMAC signatures) and resolve
 * them to an Actor.
 */
export interface IdentityVerifier {
  verify(input: IdentityVerifyInput): Promise<IdentityVerificationResult>;
}

/**
 * Identity provider port. Implementations create and resolve
 * actors across the system.
 */
export interface IdentityProvider {
  getActor(actorId: string): Promise<Actor | null>;
  findActorsByOrganization(organizationId: string): Promise<Actor[]>;
}

/**
 * Requirements for authorizing a principal against a specific
 * route or action.
 */
export interface PrincipalAuthorizationRequirements {
  organizationId?: string;
  requiredScopes?: readonly string[];
  requiredRoles?: readonly string[];
}

export type PrincipalAuthorizationResult =
  | { ok: true; actor: Actor }
  | {
      ok: false;
      code: Extract<IdentityErrorCode, "organization_denied" | "scope_denied" | "role_denied">;
    };

/**
 * Applies route-level organization, scope, and role checks to a
 * verified actor. Returns no reason text that could leak context.
 */
export function authorizePrincipal(
  actor: Actor,
  requirements: PrincipalAuthorizationRequirements,
): PrincipalAuthorizationResult {
  if (requirements.organizationId && actor.organizationId !== requirements.organizationId) {
    return { ok: false, code: "organization_denied" };
  }

  if (requirements.requiredScopes?.some((required) => !hasScope(actor, required)) ?? false) {
    return { ok: false, code: "scope_denied" };
  }

  if (requirements.requiredRoles && requirements.requiredRoles.length > 0) {
    const actorRoles = (actor.metadata?.roles as string[]) ?? [];
    const hasRole = requirements.requiredRoles.some((r) => actorRoles.includes(r));
    if (!hasRole) {
      return { ok: false, code: "role_denied" };
    }
  }

  return { ok: true, actor };
}

/**
 * Canonical scope hierarchy for actor authorization.
 * - `write` includes everything.
 * - `deploy` includes only deploy (CI pipelines).
 * - `read.history` includes read + read.history.
 * - `read` includes only read.
 */
const SCOPE_HIERARCHY: Record<string, readonly string[]> = {
  read: ["read"],
  "read.history": ["read", "read.history"],
  write: ["read", "read.history", "write", "deploy"],
  deploy: ["deploy"],
};

/**
 * Check whether an actor has a specific scope granted.
 * A granted scope implicitly satisfies any required scope that is at or
 * below it in the hierarchy.
 */
export function hasScope(actor: Actor, required: string): boolean {
  const scopes = (actor.metadata?.scopes as string[] | undefined) ?? [];
  return scopes.some((g) => SCOPE_HIERARCHY[g]?.includes(required) ?? false);
}

/**
 * Repository interface for API key persistence. Abstracts the
 * database adapter so the identity package has no direct Drizzle
 * dependency.
 */
export interface ApiKeyRepository {
  findByHash(hash: string): Promise<{
    id: string;
    userId: string;
    organizationId: string;
    scopes: string[];
    createdByUserId: string | null;
    expiresAt: Date | null;
    revokedAt: Date | null;
  } | null>;
  touchLastUsed(apiKeyId: string): Promise<void>;
}

/**
 * Repository interface for login attempt persistence.
 */
export interface LoginAttemptRepository {
  countRecentFails(email: string, ipAddress: string | null, since: Date): Promise<number>;
  newestFailAt(email: string, ipAddress: string | null, since: Date): Promise<Date | null>;
  record(input: {
    email: string;
    ipAddress: string | null;
    userId: string | null;
    organizationId: string | null;
    result: string;
    userAgent: string | null;
  }): void;
}
