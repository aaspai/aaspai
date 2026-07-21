import type { AuthPrincipal } from "@aaspai/contracts";
import { describe, expect, it } from "vitest";
import {
  AuthVerificationError,
  authorizePrincipal,
  InMemoryAuthVerifier,
  safeAuthMessage,
} from "../src";

const sessionPrincipal: AuthPrincipal = {
  protocolVersion: 1,
  userId: "user-1",
  organizationId: "org-1",
  sessionId: "session-1",
  roles: ["member"],
  scopes: ["read"],
  authMethod: "session",
};

const apiKeyPrincipal: AuthPrincipal = {
  protocolVersion: 1,
  userId: "user-2",
  organizationId: "org-2",
  apiKeyId: "key-2",
  roles: ["operator"],
  scopes: ["read", "deploy"],
  authMethod: "api_key",
};

describe("API-owned auth verifier port", () => {
  it("fails closed for missing, malformed, unknown, expired, and revoked credentials", async () => {
    const verifier = new InMemoryAuthVerifier([
      { token: "valid-token", principal: sessionPrincipal },
      { token: "expired-token", principal: sessionPrincipal, expiresAt: new Date(0) },
      { token: "revoked-token", principal: sessionPrincipal, revoked: true },
    ]);

    await expect(verifier.verify({})).resolves.toEqual({ ok: false, code: "missing_credential" });
    await expect(verifier.verify({ credential: { kind: "bearer", value: "" } })).resolves.toEqual({
      ok: false,
      code: "malformed_credential",
    });
    await expect(
      verifier.verify({ credential: { kind: "bearer", value: "unknown-token" } }),
    ).resolves.toEqual({ ok: false, code: "invalid_credential" });
    await expect(
      verifier.verify({ credential: { kind: "bearer", value: "expired-token" } }),
    ).resolves.toEqual({ ok: false, code: "expired_credential" });
    await expect(
      verifier.verify({ credential: { kind: "bearer", value: "revoked-token" } }),
    ).resolves.toEqual({ ok: false, code: "revoked_credential" });
  });

  it("returns only the sanitized principal on success", async () => {
    const verifier = new InMemoryAuthVerifier([
      { token: "valid-token", principal: sessionPrincipal },
    ]);
    const result = await verifier.verify({ credential: { kind: "session", value: "valid-token" } });
    expect(result).toEqual({ ok: true, principal: sessionPrincipal });
    expect(JSON.stringify(result)).not.toContain("valid-token");
    expect(JSON.stringify(result)).not.toContain("credential");
  });

  it("applies organization, scope, and role checks without leaking details", () => {
    expect(authorizePrincipal(sessionPrincipal, { organizationId: "org-2" })).toEqual({
      ok: false,
      code: "organization_denied",
    });
    expect(authorizePrincipal(sessionPrincipal, { requiredScopes: ["deploy"] })).toEqual({
      ok: false,
      code: "scope_denied",
    });
    expect(authorizePrincipal(sessionPrincipal, { requiredRoles: ["operator"] })).toEqual({
      ok: false,
      code: "role_denied",
    });
    expect(
      authorizePrincipal(apiKeyPrincipal, {
        organizationId: "org-2",
        requiredScopes: ["read"],
        requiredRoles: ["operator"],
      }),
    ).toEqual({ ok: true, principal: apiKeyPrincipal });
  });

  it("uses stable sanitized error messages", () => {
    const error = new AuthVerificationError("invalid_credential");
    expect(error.code).toBe("invalid_credential");
    expect(error.message).toBe(safeAuthMessage("invalid_credential"));
    expect(error.message).not.toContain("token");
    expect(error.message).not.toContain("secret");
  });
});
