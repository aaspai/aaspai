import type { AuthVerifier } from "@aaspai/auth/port";
import { describe, expect, it } from "vitest";

/**
 * Shared contract test suite for AuthVerifier implementations.
 *
 * Usage:
 * ```ts
 * import { describeAuthVerifierContract } from "@aaspai/testing/contracts";
 * import { InMemoryAuthVerifier } from "@aaspai/auth";
 *
 * describeAuthVerifierContract("InMemory", () => new InMemoryAuthVerifier());
 * ```
 *
 * Tests the *required* behaviour every AuthVerifier must honour regardless
 * of underlying provider (in-memory fixture, Better Auth adapter, etc.).
 * Provider-specific tests belong in the adapter's own test file.
 */
export function describeAuthVerifierContract(
  label: string,
  factory: () => AuthVerifier,
): void {
  describe(`AuthVerifier contract: ${label}`, () => {
    it("fails closed for missing credential", async () => {
      const verifier = factory();
      const result = await verifier.verify({});
      expect(result.ok).toBe(false);
    });

    it("rejects empty credential value", async () => {
      const verifier = factory();
      const result = await verifier.verify({ credential: { kind: "bearer", value: "" } });
      expect(result.ok).toBe(false);
    });

    it("rejects unknown credential", async () => {
      const verifier = factory();
      const result = await verifier.verify({
        credential: { kind: "bearer", value: "unknown-token" },
      });
      expect(result.ok).toBe(false);
    });

    it("never includes the credential value in the result", async () => {
      const verifier = factory();
      const result = await verifier.verify({
        credential: { kind: "bearer", value: "must-not-leak-secret-token" },
      });
      expect(JSON.stringify(result)).not.toContain("must-not-leak-secret-token");
    });
  });
}
