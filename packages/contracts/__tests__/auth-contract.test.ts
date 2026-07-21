import { describe, expect, it } from "vitest";
import {
  AUTH_PROTOCOL_VERSION,
  apiRequestContextSchema,
  authPrincipalSchema,
  authVerificationResultSchema,
} from "../src/auth";

const sessionPrincipal = {
  protocolVersion: AUTH_PROTOCOL_VERSION,
  userId: "user-1",
  organizationId: "org-1",
  sessionId: "session-1",
  roles: ["member"],
  scopes: ["read"],
  authMethod: "session" as const,
};

describe("authentication boundary contracts", () => {
  it("accepts a sanitized session principal and request context", () => {
    const principal = authPrincipalSchema.parse(sessionPrincipal);
    const context = apiRequestContextSchema.parse({
      protocolVersion: AUTH_PROTOCOL_VERSION,
      requestId: "req-123",
      principal,
    });

    expect(context.principal.organizationId).toBe("org-1");
    expect(JSON.stringify(context)).not.toContain("token");
    expect(JSON.stringify(context)).not.toContain("cookie");
  });

  it("accepts API-key principals without exposing a credential value", () => {
    const principal = authPrincipalSchema.parse({
      ...sessionPrincipal,
      sessionId: undefined,
      apiKeyId: "key-1",
      authMethod: "api_key",
      scopes: ["read", "read.history"],
    });
    expect(principal.apiKeyId).toBe("key-1");
    expect(Object.keys(principal)).not.toContain("token");
    expect(Object.keys(principal)).not.toContain("secret");
  });

  it("rejects malformed, unscoped, duplicate, and unknown fields", () => {
    expect(
      authPrincipalSchema.safeParse({ ...sessionPrincipal, organizationId: " " }).success,
    ).toBe(false);
    expect(
      authPrincipalSchema.safeParse({
        ...sessionPrincipal,
        scopes: ["read", "read"] as const,
      }).success,
    ).toBe(false);
    expect(authPrincipalSchema.safeParse({ ...sessionPrincipal, token: "raw-token" }).success).toBe(
      false,
    );
    expect(
      authPrincipalSchema.safeParse({ ...sessionPrincipal, sessionId: undefined }).success,
    ).toBe(false);
    expect(
      authPrincipalSchema.safeParse({
        ...sessionPrincipal,
        authMethod: "api_key",
        sessionId: undefined,
      }).success,
    ).toBe(false);
  });

  it("validates stable verification success/failure envelopes", () => {
    expect(
      authVerificationResultSchema.safeParse({ ok: true, principal: sessionPrincipal }).success,
    ).toBe(true);
    for (const code of [
      "missing_credential",
      "malformed_credential",
      "invalid_credential",
      "expired_credential",
      "revoked_credential",
      "organization_denied",
      "scope_denied",
      "role_denied",
    ]) {
      expect(authVerificationResultSchema.safeParse({ ok: false, code }).success).toBe(true);
    }
    expect(authVerificationResultSchema.safeParse({ ok: false, code: "raw-token" }).success).toBe(
      false,
    );
  });
});
