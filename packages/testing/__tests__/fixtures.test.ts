import { describe, expect, it } from "vitest";
import { createActorFixture, createOrganizationFixture } from "../src/fixtures";

describe("createActorFixture", () => {
  it("creates an actor with default values", () => {
    const actor = createActorFixture();
    expect(actor.id).toBeTruthy();
    expect(actor.type).toBe("human");
    expect(actor.organizationId).toBe("test-org");
  });

  it("respects overrides", () => {
    const actor = createActorFixture({
      id: "custom-id",
      type: "agent",
      organizationId: "custom-org",
    });
    expect(actor.id).toBe("custom-id");
    expect(actor.type).toBe("agent");
    expect(actor.organizationId).toBe("custom-org");
  });
});

describe("createOrganizationFixture", () => {
  it("creates an org with default values", () => {
    const org = createOrganizationFixture();
    expect(org.id).toBeTruthy();
    expect(org.name).toBe("Test Organization");
  });

  it("respects overrides", () => {
    const org = createOrganizationFixture({ id: "org-42", name: "Custom Org" });
    expect(org.id).toBe("org-42");
    expect(org.name).toBe("Custom Org");
  });
});
