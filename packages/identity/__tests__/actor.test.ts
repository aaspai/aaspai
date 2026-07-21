import { IDENTITY_PROTOCOL_VERSION } from "@aaspai/contracts/identity";
import { describe, expect, it } from "vitest";
import { actorTypeLabel, createActor } from "../src/actor";

describe("createActor", () => {
  it("creates an actor with the given properties", () => {
    const actor = createActor({
      id: "actor-1",
      type: "human",
      organizationId: "org-1",
      displayName: "Test User",
    });
    expect(actor.protocolVersion).toBe(IDENTITY_PROTOCOL_VERSION);
    expect(actor.id).toBe("actor-1");
    expect(actor.type).toBe("human");
    expect(actor.organizationId).toBe("org-1");
    expect(actor.displayName).toBe("Test User");
    expect(typeof actor.createdAt).toBe("string");
  });

  it("enforces the identity protocol version", () => {
    const actor = createActor({
      id: "actor-2",
      type: "service",
      organizationId: "org-1",
    });
    expect(actor.protocolVersion).toBe(IDENTITY_PROTOCOL_VERSION);
  });

  it("accepts all actor types", () => {
    for (const type of ["human", "agent", "service", "system", "team"] as const) {
      const actor = createActor({
        id: `actor-${type}`,
        type,
        organizationId: "org-1",
      });
      expect(actor.type).toBe(type);
    }
  });

  it("includes optional metadata", () => {
    const actor = createActor({
      id: "actor-3",
      type: "human",
      organizationId: "org-1",
      metadata: { roles: ["admin"], scopes: ["read"] },
    });
    expect(actor.metadata).toEqual({ roles: ["admin"], scopes: ["read"] });
  });
});

describe("actorTypeLabel", () => {
  it("returns the correct label for each type", () => {
    expect(actorTypeLabel("human")).toBe("Human User");
    expect(actorTypeLabel("agent")).toBe("AI Agent");
    expect(actorTypeLabel("service")).toBe("Service Account");
    expect(actorTypeLabel("system")).toBe("System");
    expect(actorTypeLabel("team")).toBe("Team");
  });
});
