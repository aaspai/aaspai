import type { Actor, IdentityVerificationResult, IdentityVerifyInput } from "@aaspai/contracts";

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
