import { describe, expect, it } from "vitest";
import { hasScope } from "../src/port";

const ALL_SCOPES = ["read", "read.history", "write", "deploy"] as const;

function makeActor(scopes: string[]) {
  return {
    protocolVersion: 1 as const,
    id: "actor-1",
    type: "human" as const,
    organizationId: "org-1",
    createdAt: new Date().toISOString(),
    metadata: { scopes },
  };
}

/**
 * Legacy `hasScope` from apps/web/app/api/v1/_lib/auth.ts.
 * Kept as a reference for contract parity — the canonical
 * hierarchy in `packages/identity/src/port.ts` must agree
 * with this implementation for every scope pair.
 */
function legacyHasScope(granted: readonly string[], required: string): boolean {
  if (granted.includes("write")) return true;
  if (required === "read") {
    return granted.includes("read") || granted.includes("read.history");
  }
  if (required === "read.history") {
    return granted.includes("read.history");
  }
  if (required === "deploy") {
    return granted.includes("deploy");
  }
  return false;
}

describe("scope hierarchy contract parity", () => {
  for (const granted of ALL_SCOPES) {
    for (const required of ALL_SCOPES) {
      it(`${granted} satisfies ${required}`, () => {
        const actor = makeActor([granted]);
        const canonical = hasScope(actor, required);
        const legacy = legacyHasScope([granted], required);
        expect(canonical).toBe(legacy);
      });
    }
  }

  it("write satisfies all scopes", () => {
    const actor = makeActor(["write"]);
    for (const required of ALL_SCOPES) {
      expect(hasScope(actor, required)).toBe(true);
    }
  });

  it("read satisfies only read", () => {
    const actor = makeActor(["read"]);
    expect(hasScope(actor, "read")).toBe(true);
    expect(hasScope(actor, "read.history")).toBe(false);
    expect(hasScope(actor, "write")).toBe(false);
    expect(hasScope(actor, "deploy")).toBe(false);
  });

  it("read.history satisfies read and read.history", () => {
    const actor = makeActor(["read.history"]);
    expect(hasScope(actor, "read")).toBe(true);
    expect(hasScope(actor, "read.history")).toBe(true);
    expect(hasScope(actor, "write")).toBe(false);
    expect(hasScope(actor, "deploy")).toBe(false);
  });

  it("deploy satisfies only deploy", () => {
    const actor = makeActor(["deploy"]);
    expect(hasScope(actor, "read")).toBe(false);
    expect(hasScope(actor, "read.history")).toBe(false);
    expect(hasScope(actor, "write")).toBe(false);
    expect(hasScope(actor, "deploy")).toBe(true);
  });
});
