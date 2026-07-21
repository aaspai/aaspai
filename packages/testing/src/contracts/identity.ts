import type { IdentityVerifier } from "@aaspai/identity/port";
import { describe, expect, it } from "vitest";
import { createActorFixture } from "../fixtures";

/**
 * Shared contract test suite for IdentityVerifier implementations.
 *
 * Usage:
 * ```ts
 * import { describeIdentityVerifierContract } from "@aaspai/testing/contracts";
 * import { InMemoryIdentityVerifier } from "@aaspai/identity/adapters/in-memory";
 *
 * describeIdentityVerifierContract("InMemory", () => new InMemoryIdentityVerifier());
 * ```
 */
export function describeIdentityVerifierContract(
  label: string,
  factory: () => IdentityVerifier,
): void {
  describe(`IdentityVerifier contract: ${label}`, () => {
    it("rejects missing credential", async () => {
      const verifier = factory();
      const result = await verifier.verify({});
      expect(result.ok).toBe(false);
    });

    it("rejects empty credential value", async () => {
      const verifier = factory();
      const result = await verifier.verify({
        credential: { kind: "bearer", value: "" },
      });
      expect(result.ok).toBe(false);
    });

    it("rejects unknown token", async () => {
      const verifier = factory();
      const result = await verifier.verify({
        credential: { kind: "bearer", value: "unknown-token" },
      });
      expect(result.ok).toBe(false);
    });
  });
}
