import { describe, expect, it } from "vitest";
import { InMemoryIdentityVerifier } from "../src/adapters/in-memory";

const testActor = {
  protocolVersion: 1 as const,
  id: "actor-1",
  type: "human" as const,
  organizationId: "org-1",
  createdAt: new Date().toISOString(),
};

describe("InMemoryIdentityVerifier", () => {
  it("rejects missing credential", async () => {
    const verifier = new InMemoryIdentityVerifier();
    const result = await verifier.verify({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("missing_credential");
  });

  it("rejects malformed credential", async () => {
    const verifier = new InMemoryIdentityVerifier();
    const result = await verifier.verify({
      credential: { kind: "bearer" as const, value: "" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("malformed_credential");
  });

  it("rejects unknown credential kind", async () => {
    const verifier = new InMemoryIdentityVerifier();
    const result = await verifier.verify({
      // @ts-expect-error - testing invalid kind
      credential: { kind: "unknown", value: "token" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("malformed_credential");
  });

  it("accepts valid bearer token", async () => {
    const verifier = new InMemoryIdentityVerifier([{ token: "valid-token", actor: testActor }]);
    const result = await verifier.verify({
      credential: { kind: "bearer", value: "valid-token" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actor.id).toBe("actor-1");
      expect(result.actor.organizationId).toBe("org-1");
    }
  });

  it("rejects unknown token", async () => {
    const verifier = new InMemoryIdentityVerifier([{ token: "valid-token", actor: testActor }]);
    const result = await verifier.verify({
      credential: { kind: "bearer", value: "unknown-token" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_credential");
  });

  it("rejects revoked token", async () => {
    const verifier = new InMemoryIdentityVerifier([{ token: "valid-token", actor: testActor }]);
    verifier.revoke("valid-token");
    const result = await verifier.verify({
      credential: { kind: "bearer", value: "valid-token" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("revoked_credential");
  });

  it("rejects expired token", async () => {
    const verifier = new InMemoryIdentityVerifier([
      {
        token: "expired-token",
        actor: testActor,
        expiresAt: new Date(Date.now() - 60_000),
      },
    ]);
    const result = await verifier.verify({
      credential: { kind: "bearer", value: "expired-token" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("expired_credential");
  });

  it("accepts valid session credential", async () => {
    const verifier = new InMemoryIdentityVerifier([{ token: "session-token", actor: testActor }]);
    const result = await verifier.verify({
      credential: { kind: "session", value: "session-token" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actor.id).toBe("actor-1");
    }
  });

  it("rejects whitespace in credential value", async () => {
    const verifier = new InMemoryIdentityVerifier();
    const result = await verifier.verify({
      credential: { kind: "bearer", value: "token with space" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("malformed_credential");
  });
});
