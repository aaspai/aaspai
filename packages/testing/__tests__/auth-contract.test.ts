import { describe, expect, it } from "vitest";
import { InMemoryAuthVerifier } from "@aaspai/auth";
import { authPrincipalSchema, type AuthVerificationResult } from "@aaspai/contracts";
import { describeAuthVerifierContract } from "@aaspai/testing/contracts";

const principal = authPrincipalSchema.parse({
  protocolVersion: 1,
  userId: "user-1",
  organizationId: "org-1",
  sessionId: "session-1",
  roles: ["member"],
  scopes: ["read"],
  authMethod: "session",
});

describe("InMemoryAuthVerifier", () => {
  describeAuthVerifierContract("InMemory", () => new InMemoryAuthVerifier([
    { token: "valid-token", principal },
  ]));

  it("succeeds for a known credential", async () => {
    const v = new InMemoryAuthVerifier([{ token: "valid-token", principal }]);
    const result: AuthVerificationResult = await v.verify({
      credential: { kind: "session", value: "valid-token" },
    });
    expect(result.ok).toBe(true);
  });
});
