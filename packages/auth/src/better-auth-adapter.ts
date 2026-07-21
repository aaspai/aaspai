import {
  type ApiScope,
  type AuthPrincipal,
  type AuthVerificationResult,
  apiScopeSchema,
  authPrincipalSchema,
} from "@aaspai/contracts";
import { getLogger } from "@aaspai/observability";
import type { AuthVerifier, AuthVerifyInput } from "./port";

const log = getLogger("auth.better-auth-adapter");

/**
 * The small subset of Better Auth's server API consumed by the API process.
 * Keeping this structural type here prevents the provider and its database
 * adapter from becoming dependencies of the public auth package.
 */
export interface BetterAuthSessionApi {
  getSession(input: { headers: Headers }): Promise<unknown>;
}

export interface BetterAuthSessionAuthorization {
  organizationId?: string | null;
  roles?: readonly string[];
  scopes?: readonly ApiScope[];
}

export interface BetterAuthApiKeyIdentity {
  apiKeyId: string;
  userId: string;
  organizationId: string;
  scopes: readonly ApiScope[];
  roles?: readonly string[];
}

export interface BetterAuthVerifierOptions {
  /** Better Auth's process-local `auth.api` object. */
  sessionApi: BetterAuthSessionApi;
  /**
   * API-key verification is injected from the composition root. The adapter
   * never reads the database or hashes credentials itself.
   */
  verifyApiKey?: (token: string) => Promise<BetterAuthApiKeyIdentity | null>;
  /**
   * Resolves organization membership and authorization for a session. The
   * default is deliberately read-only and uses the active organization in
   * the session, so a missing resolver cannot accidentally grant writes.
   */
  resolveSessionAuthorization?: (
    session: BetterAuthSessionRecord,
  ) => Promise<BetterAuthSessionAuthorization | null>;
}

/** Normalized fields read from Better Auth's opaque session response. */
export interface BetterAuthSessionRecord {
  user: { id: string };
  session: {
    id: string;
    activeOrganizationId?: string | null;
    /** P1-Auth-2: set by the two-factor plugin after sign-in until TOTP is verified. */
    twoFactorRedirect?: boolean;
  };
}

const MAX_CREDENTIAL_LENGTH = 4096;

/**
 * Cookie values are copied into a provider-owned `Headers` object. Reject
 * control characters before constructing that object so malformed proxy input
 * cannot be interpreted as a second header by a future provider adapter.
 */
function isSafeCookieHeader(value: string): boolean {
  return !Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

function invalid(): AuthVerificationResult {
  return { ok: false, code: "invalid_credential" };
}

function boundedString(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return null;
  return value;
}

function parseSession(value: unknown): BetterAuthSessionRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as {
    user?: { id?: unknown };
    session?: { id?: unknown; activeOrganizationId?: unknown; twoFactorRedirect?: unknown };
  };
  const userId = boundedString(raw.user?.id);
  const sessionId = boundedString(raw.session?.id);
  if (!userId || !sessionId) return null;
  const activeOrganizationId = raw.session?.activeOrganizationId;
  const twoFactorRedirect = raw.session?.twoFactorRedirect;
  const normalizedTwoFactorRedirect =
    typeof twoFactorRedirect === "boolean" ? twoFactorRedirect : undefined;
  if (activeOrganizationId !== undefined && activeOrganizationId !== null) {
    const normalizedOrganizationId = boundedString(activeOrganizationId);
    if (!normalizedOrganizationId) return null;
    return {
      user: { id: userId },
      session: {
        id: sessionId,
        activeOrganizationId: normalizedOrganizationId,
        twoFactorRedirect: normalizedTwoFactorRedirect,
      },
    };
  }
  return {
    user: { id: userId },
    session: { id: sessionId, twoFactorRedirect: normalizedTwoFactorRedirect },
  };
}

/** B1: Frozen defaults used when no authorization is resolved. These are
 * deliberately the most restrictive defaults — read-only member access.
 * The warning log helps detect missing authorization resolvers in production.
 */
const DEFAULT_SESSION_ROLES: readonly string[] = Object.freeze(["member"]);
const DEFAULT_SESSION_SCOPES: readonly ApiScope[] = Object.freeze(["read"]);

function principalFromSession(
  session: BetterAuthSessionRecord,
  authorization: BetterAuthSessionAuthorization | null | undefined,
): AuthPrincipal | null {
  const organizationId = authorization?.organizationId ?? session.session.activeOrganizationId;
  if (!organizationId) return null;
  if (!authorization?.roles || !authorization?.scopes) {
    log.warn("principalFromSession fallback triggered", {
      userId: session.user.id,
      reason: "no authorization resolved, using default member/read",
    });
  }
  const roles = authorization?.roles ?? DEFAULT_SESSION_ROLES;
  const scopes = authorization?.scopes ?? DEFAULT_SESSION_SCOPES;
  const parsedScopes = scopes.map((scope) => apiScopeSchema.safeParse(scope));
  if (parsedScopes.some((scope) => !scope.success)) return null;
  const principal = authPrincipalSchema.safeParse({
    protocolVersion: 1,
    userId: session.user.id,
    organizationId,
    sessionId: session.session.id,
    roles,
    scopes,
    authMethod: "session",
    twoFactorRedirect: session.session.twoFactorRedirect,
  });
  return principal.success ? principal.data : null;
}

function principalFromApiKey(identity: BetterAuthApiKeyIdentity): AuthPrincipal | null {
  const scopes = identity.scopes.map((scope) => apiScopeSchema.safeParse(scope));
  if (scopes.some((scope) => !scope.success)) return null;
  const principal = authPrincipalSchema.safeParse({
    protocolVersion: 1,
    userId: identity.userId,
    organizationId: identity.organizationId,
    apiKeyId: identity.apiKeyId,
    roles: identity.roles ?? [],
    scopes: identity.scopes,
    authMethod: "api_key",
  });
  return principal.success ? principal.data : null;
}

/**
 * Adapts Better Auth's session API and the existing API-key verifier to the
 * API-owned `AuthVerifier` port. Provider errors are intentionally collapsed
 * to one stable failure code and credentials never appear in a result.
 */
export function createBetterAuthVerifier(options: BetterAuthVerifierOptions): AuthVerifier {
  return {
    async verify(input: AuthVerifyInput): Promise<AuthVerificationResult> {
      const credential = input.credential;
      if (!credential?.value || credential.value.length > MAX_CREDENTIAL_LENGTH) {
        return { ok: false, code: credential ? "malformed_credential" : "missing_credential" };
      }

      if (!isSafeCookieHeader(credential.value)) {
        return { ok: false, code: "malformed_credential" };
      }

      if (credential.kind === "bearer") {
        if (!options.verifyApiKey) return invalid();
        try {
          const identity = await options.verifyApiKey(credential.value);
          if (!identity) return invalid();
          const principal = principalFromApiKey(identity);
          return principal ? { ok: true, principal } : invalid();
        } catch {
          return invalid();
        }
      }

      try {
        const raw = await options.sessionApi.getSession({
          headers: new Headers({ Cookie: credential.value }),
        });
        const session = parseSession(raw);
        if (!session) return invalid();
        const authorization = options.resolveSessionAuthorization
          ? await options.resolveSessionAuthorization(session)
          : undefined;
        const principal = principalFromSession(session, authorization);
        return principal ? { ok: true, principal } : invalid();
      } catch {
        return invalid();
      }
    },
  };
}
