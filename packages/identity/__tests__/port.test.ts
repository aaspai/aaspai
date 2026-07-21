import type { Actor } from "@aaspai/contracts/identity";
import { describe, expect, it } from "vitest";
import { authorizePrincipal, hasScope } from "../src/port";

function makeActor(overrides: Partial<Actor> & { id: string; organizationId: string }): Actor {
  return {
    protocolVersion: 1 as const,
    id: overrides.id,
    type: (overrides.type ?? "human") as Actor["type"],
    organizationId: overrides.organizationId,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    displayName: overrides.displayName,
    metadata: overrides.metadata,
  };
}

const actor: Actor = makeActor({
  id: "user-1",
  organizationId: "org-1",
  metadata: { roles: ["owner"], scopes: ["read", "deploy"] },
});

describe("authorizePrincipal", () => {
  it("authorizes matching organization", () => {
    const result = authorizePrincipal(actor, { organizationId: "org-1" });
    expect(result.ok).toBe(true);
  });

  it("denies wrong organization", () => {
    const result = authorizePrincipal(actor, { organizationId: "org-2" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("organization_denied");
  });

  it("authorizes matching scope", () => {
    const result = authorizePrincipal(actor, { requiredScopes: ["read"] });
    expect(result.ok).toBe(true);
  });

  it("denies missing scope", () => {
    const result = authorizePrincipal(actor, { requiredScopes: ["write"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("scope_denied");
  });

  it("authorizes matching role", () => {
    const result = authorizePrincipal(actor, { requiredRoles: ["owner"] });
    expect(result.ok).toBe(true);
  });

  it("denies missing role", () => {
    const result = authorizePrincipal(actor, { requiredRoles: ["admin"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("role_denied");
  });

  it("authorizes with empty requirements", () => {
    const result = authorizePrincipal(actor, {});
    expect(result.ok).toBe(true);
  });

  it("authorizes multiple requirements", () => {
    const result = authorizePrincipal(actor, {
      organizationId: "org-1",
      requiredScopes: ["read"],
      requiredRoles: ["owner"],
    });
    expect(result.ok).toBe(true);
  });
});

describe("hasScope", () => {
  it("read satisfies read", () => {
    expect(hasScope(actor, "read")).toBe(true);
  });

  it("deploy satisfies deploy", () => {
    expect(hasScope(actor, "deploy")).toBe(true);
  });

  it("does not satisfy write", () => {
    const readOnlyActor = makeActor({
      id: "user-2",
      organizationId: "org-1",
      metadata: { scopes: ["read"] },
    });
    expect(hasScope(readOnlyActor, "write")).toBe(false);
  });

  it("read.history satisfies read", () => {
    const historyActor = makeActor({
      id: "user-2",
      organizationId: "org-1",
      metadata: { scopes: ["read.history"] },
    });
    expect(hasScope(historyActor, "read")).toBe(true);
  });

  it("write satisfies everything", () => {
    const writeScopeActor = makeActor({
      id: "user-2",
      organizationId: "org-1",
      metadata: { scopes: ["write"] },
    });
    expect(hasScope(writeScopeActor, "read")).toBe(true);
    expect(hasScope(writeScopeActor, "read.history")).toBe(true);
    expect(hasScope(writeScopeActor, "write")).toBe(true);
    expect(hasScope(writeScopeActor, "deploy")).toBe(true);
  });

  it("returns false for empty scopes", () => {
    const noScopeActor = makeActor({
      id: "user-2",
      organizationId: "org-1",
    });
    expect(hasScope(noScopeActor, "read")).toBe(false);
  });
});
