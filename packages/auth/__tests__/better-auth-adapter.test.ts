import { describe, expect, it } from "vitest";
import {
  type BetterAuthApiKeyIdentity,
  type BetterAuthSessionRecord,
  type BetterAuthSessionApi,
  createBetterAuthVerifier,
} from "@aaspai/auth/better-auth-adapter";
import { authPrincipalSchema } from "@aaspai/contracts";
import { describeAuthVerifierContract } from "@aaspai/testing/contracts";

/** A no-network session stub. Configure `getSession` per test. */
function makeSessionApi(impl: (input: { headers: Headers }) => Promise<unknown>): BetterAuthSessionApi {
  return { getSession: impl };
}

function apiKeyIdentity(overrides: Partial<BetterAuthApiKeyIdentity> = {}): BetterAuthApiKeyIdentity {
  return {
    apiKeyId: "key_abc",
    userId: "user_1",
    organizationId: "org_1",
    scopes: ["read", "deploy"],
    ...overrides,
  };
}

function sessionRecord(overrides: Partial<BetterAuthSessionRecord> = {}): BetterAuthSessionRecord {
  return {
    user: { id: "user_1" },
    session: { id: "session_1", activeOrganizationId: "org_1" },
    ...overrides,
  };
}

describe("createBetterAuthVerifier", () => {
  // Shared contract — every AuthVerifier must satisfy these.
  describeAuthVerifierContract("BetterAuth", () =>
    createBetterAuthVerifier({
      sessionApi: makeSessionApi(async () => null),
    }),
  );

  describe("input validation", () => {
    it("fails when no credential is provided", async () => {
      const v = createBetterAuthVerifier({ sessionApi: makeSessionApi(async () => null) });
      const result = await v.verify({});
      expect(result).toEqual({ ok: false, code: "missing_credential" });
    });

    it("fails when credential value is empty", async () => {
      const v = createBetterAuthVerifier({ sessionApi: makeSessionApi(async () => null) });
      const result = await v.verify({ credential: { kind: "session", value: "" } });
      // B3: Better Auth adapter maps an empty value to malformed_credential
      // (missing_credential is reserved for "no credential object at all").
      expect(result).toEqual({ ok: false, code: "malformed_credential" });
    });

    it("fails when credential value exceeds max length", async () => {
      const v = createBetterAuthVerifier({ sessionApi: makeSessionApi(async () => null) });
      const result = await v.verify({
        credential: { kind: "session", value: "x".repeat(4_097) },
      });
      expect(result).toEqual({ ok: false, code: "malformed_credential" });
    });

    it("rejects control characters in the credential (cookie smuggling)", async () => {
      const v = createBetterAuthVerifier({ sessionApi: makeSessionApi(async () => null) });
      const result = await v.verify({
        credential: { kind: "session", value: "ok=1\u0000bad=2" },
      });
      expect(result).toEqual({ ok: false, code: "malformed_credential" });
    });

    it("does not include the credential value in any result field", async () => {
      const v = createBetterAuthVerifier({ sessionApi: makeSessionApi(async () => null) });
      const result = await v.verify({ credential: { kind: "session", value: "secret-cookie" } });
      expect(JSON.stringify(result)).not.toContain("secret-cookie");
    });
  });

  describe("bearer / api-key path", () => {
    it("returns invalid when no verifyApiKey is configured", async () => {
      const v = createBetterAuthVerifier({ sessionApi: makeSessionApi(async () => null) });
      const result = await v.verify({ credential: { kind: "bearer", value: "abc" } });
      expect(result).toEqual({ ok: false, code: "invalid_credential" });
    });

    it("returns invalid when verifyApiKey rejects the token", async () => {
      const v = createBetterAuthVerifier({
        sessionApi: makeSessionApi(async () => null),
        verifyApiKey: async () => null,
      });
      const result = await v.verify({ credential: { kind: "bearer", value: "abc" } });
      expect(result).toEqual({ ok: false, code: "invalid_credential" });
    });

    it("returns invalid when verifyApiKey throws", async () => {
      const v = createBetterAuthVerifier({
        sessionApi: makeSessionApi(async () => null),
        verifyApiKey: async () => {
          throw new Error("db unreachable");
        },
      });
      const result = await v.verify({ credential: { kind: "bearer", value: "abc" } });
      expect(result).toEqual({ ok: false, code: "invalid_credential" });
    });

    it("returns a sanitized principal on success", async () => {
      const identity = apiKeyIdentity();
      const v = createBetterAuthVerifier({
        sessionApi: makeSessionApi(async () => null),
        verifyApiKey: async () => identity,
      });
      const result = await v.verify({ credential: { kind: "bearer", value: "key_abc" } });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const principal = authPrincipalSchema.parse(result.principal);
      expect(principal.userId).toBe("user_1");
      expect(principal.organizationId).toBe("org_1");
      expect(principal.apiKeyId).toBe("key_abc");
      expect(principal.authMethod).toBe("api_key");
      expect(principal.scopes).toEqual(["read", "deploy"]);
    });

    it("rejects api-key identities with invalid scopes", async () => {
      const v = createBetterAuthVerifier({
        sessionApi: makeSessionApi(async () => null),
        verifyApiKey: async () => apiKeyIdentity({ scopes: ["nope" as never] }),
      });
      const result = await v.verify({ credential: { kind: "bearer", value: "key_abc" } });
      expect(result).toEqual({ ok: false, code: "invalid_credential" });
    });
  });

  describe("session path", () => {
    it("returns a principal when the session API yields a valid record", async () => {
      const v = createBetterAuthVerifier({
        sessionApi: makeSessionApi(async () => sessionRecord()),
      });
      const result = await v.verify({ credential: { kind: "session", value: "Cookie: sid=abc" } });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.principal.userId).toBe("user_1");
      expect(result.principal.organizationId).toBe("org_1");
      expect(result.principal.authMethod).toBe("session");
      expect(result.principal.sessionId).toBe("session_1");
    });

    it("returns invalid when the session record is malformed", async () => {
      const v = createBetterAuthVerifier({
        sessionApi: makeSessionApi(async () => ({ user: {}, session: {} })),
      });
      const result = await v.verify({ credential: { kind: "session", value: "cookie" } });
      expect(result).toEqual({ ok: false, code: "invalid_credential" });
    });

    it("returns invalid when the session API throws", async () => {
      const v = createBetterAuthVerifier({
        sessionApi: makeSessionApi(async () => {
          throw new Error("provider down");
        }),
      });
      const result = await v.verify({ credential: { kind: "session", value: "cookie" } });
      expect(result).toEqual({ ok: false, code: "invalid_credential" });
    });

    it("returns invalid when no organization can be resolved", async () => {
      const v = createBetterAuthVerifier({
        sessionApi: makeSessionApi(async () => ({
          user: { id: "u1" },
          session: { id: "s1" },
        })),
      });
      const result = await v.verify({ credential: { kind: "session", value: "cookie" } });
      expect(result).toEqual({ ok: false, code: "invalid_credential" });
    });

    it("uses the active organization from the session when no resolver is configured", async () => {
      const v = createBetterAuthVerifier({
        sessionApi: makeSessionApi(async () => ({
          user: { id: "u1" },
          session: { id: "s1", activeOrganizationId: "org_x" },
        })),
      });
      const result = await v.verify({ credential: { kind: "session", value: "cookie" } });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.principal.organizationId).toBe("org_x");
      // B1: defaults to read-only member access
      expect(result.principal.roles).toEqual(["member"]);
      expect(result.principal.scopes).toEqual(["read"]);
    });

    it("lets the resolver override organization, roles, and scopes", async () => {
      const v = createBetterAuthVerifier({
        sessionApi: makeSessionApi(async () => sessionRecord()),
        resolveSessionAuthorization: async () => ({
          organizationId: "org_custom",
          roles: ["admin", "operator"],
          scopes: ["write", "deploy"],
        }),
      });
      const result = await v.verify({ credential: { kind: "session", value: "cookie" } });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.principal.organizationId).toBe("org_custom");
      expect(result.principal.roles).toEqual(["admin", "operator"]);
      expect(result.principal.scopes).toEqual(["write", "deploy"]);
    });

    it("propagates twoFactorRedirect from the session into the principal", async () => {
      const v = createBetterAuthVerifier({
        sessionApi: makeSessionApi(async () => ({
          user: { id: "u1" },
          session: { id: "s1", activeOrganizationId: "o1", twoFactorRedirect: true },
        })),
      });
      const result = await v.verify({ credential: { kind: "session", value: "cookie" } });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.principal.twoFactorRedirect).toBe(true);
    });

    it("rejects authorization with invalid scopes", async () => {
      const v = createBetterAuthVerifier({
        sessionApi: makeSessionApi(async () => sessionRecord()),
        resolveSessionAuthorization: async () => ({
          organizationId: "org_custom",
          roles: ["admin"],
          scopes: ["nope" as never],
        }),
      });
      const result = await v.verify({ credential: { kind: "session", value: "cookie" } });
      expect(result).toEqual({ ok: false, code: "invalid_credential" });
    });
  });
});
