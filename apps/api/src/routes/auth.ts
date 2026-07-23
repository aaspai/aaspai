import { type AuthVerifier, authorizePrincipal } from "@aaspai/auth";
import type { ApiScope, AuthPrincipal } from "@aaspai/contracts";
import type { Context } from "hono";

export type AuthResult = { principal: AuthPrincipal } | { response: Response };

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

  const authorized = authorizePrincipal(verified.principal, { requiredScopes: [requiredScope] });
  if (!authorized.ok) {
    return {
      response: c.json({ error: authorized.code, message: "Authentication scope denied" }, 403),
    };
  }
  return { principal: authorized.principal };
}
