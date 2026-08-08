import type { AuthVerifier } from "@aaspai/auth";
import type { ApiScope, AuthPrincipal } from "@aaspai/contracts";
import type { Context } from "hono";

export type AuthResult = { principal: AuthPrincipal } | { response: Response };

const SCOPE_HIERARCHY: Readonly<Record<ApiScope, readonly ApiScope[]>> = {
  read: ["read"],
  "read.history": ["read", "read.history"],
  write: ["read", "read.history", "write", "deploy"],
  deploy: ["deploy"],
};

function hasScope(granted: readonly ApiScope[], required: ApiScope): boolean {
  return granted.some((scope) => SCOPE_HIERARCHY[scope].includes(required));
}

export async function authenticate(
  c: Context,
  verifier: AuthVerifier | undefined,
  requiredScope: ApiScope,
): Promise<AuthResult> {
  if (!verifier) {
    return {
      response: c.json(
        { error: "auth_unconfigured", message: "API authentication is not configured" },
        503,
      ),
    };
  }

  const authorization = c.req.header("Authorization");
  const cookie = c.req.header("Cookie");
  const bearer = authorization?.match(/^Bearer\s+([^\s]+)$/i);
  const credential = bearer?.[1]
    ? { kind: "bearer" as const, value: bearer[1] }
    : cookie
      ? { kind: "session" as const, value: cookie }
      : undefined;
  const verified = await verifier.verify({ credential });
  if (!verified.ok) {
    return {
      response: c.json({ error: verified.code, message: "Authentication required" }, 401),
    };
  }

  if (!hasScope(verified.principal.scopes, requiredScope)) {
    return {
      response: c.json({ error: "scope_denied", message: "Authentication scope denied" }, 403),
    };
  }
  return { principal: verified.principal };
}
