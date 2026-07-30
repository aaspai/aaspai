import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createDb, type DbHandle, runMigrations } from "@aaspai/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CompanyControlPlaneError,
  CompanyControlPlaneService,
  CompanyOperationsService,
  type CompanyWorkItemInput,
} from "../src/index.js";

describe("Layer 4 company control plane", () => {
  let handle: DbHandle;
  let root: string;

  beforeEach(async () => {
    root = resolve("workspace", "layer-04-company-graph", `control-${randomUUID()}`);
    await mkdir(root, { recursive: true });
    handle = createDbForTest(root);
    runMigrations(handle);
  });

  afterEach(async () => {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  });

  it("routes through authority, creates one WorkItem, and is idempotent", async () => {
    const organizationId = "org/layer4";
    const operations = new CompanyOperationsService(handle.db);
    await operations.registerServiceAgent({
      organizationId,
      agentId: "agent/specialist",
      metadata: { capabilities: ["security"], roles: ["engineer"] },
    });
    const control = new CompanyControlPlaneService(handle.db, {
      async createWorkItem(input: CompanyWorkItemInput) {
        expect(input.idempotencyKey).toBe("route/security-1");
        expect(input.metadata).toMatchObject({
          assignedAgentId: "agent/specialist",
          risk: "medium",
          capability: "security",
          evidencePolicy: { citationPaths: ["evidence.md"] },
        });
        return { id: "work/security-1" };
      },
    });
    await control.setAuthorityEdge({
      organizationId,
      fromAgentId: "agent/ceo",
      toAgentId: "agent/specialist",
      relation: "manages",
    });

    const input = {
      organizationId,
      idempotencyKey: "route/security-1",
      requestedByAgentId: "agent/ceo",
      targetAgentId: null,
      departmentId: null,
      requiredRole: null,
      capability: "security",
      risk: "medium" as const,
      priority: 80,
      title: "Review authentication boundary",
      description: "Review the authentication boundary and report findings.",
      goalId: "goal/security",
      projectId: "project/security",
      repositoryId: "repo/security",
      definitionRevisionId: "revision/security",
      metadata: {
        assignedAgentId: "agent/attacker",
        risk: "low",
        capability: "other",
        evidencePolicy: { citationPaths: ["evidence.md"] },
      },
    };
    const delegation = await control.delegate(input);
    expect(delegation.status).toBe("created");
    expect(delegation.targetAgentId).toBe("agent/specialist");
    expect(delegation.workItemId).toBe("work/security-1");
    expect(await control.delegate(input)).toEqual(delegation);
  });

  it("rejects authority cycles and escalates when no worker is eligible", async () => {
    const organizationId = "org/layer4-cycles";
    const control = new CompanyControlPlaneService(handle.db);
    await control.setAuthorityEdge({
      organizationId,
      fromAgentId: "agent/ceo",
      toAgentId: "agent/lead",
      relation: "manages",
    });
    await expect(
      control.setAuthorityEdge({
        organizationId,
        fromAgentId: "agent/lead",
        toAgentId: "agent/ceo",
        relation: "manages",
      }),
    ).rejects.toBeInstanceOf(CompanyControlPlaneError);

    const decision = await control.route({
      organizationId,
      idempotencyKey: "route/missing",
      requestedByAgentId: "agent/ceo",
      targetAgentId: null,
      departmentId: null,
      requiredRole: null,
      capability: "missing",
      risk: "high",
      priority: 90,
      title: "Needs a missing capability",
      description: "No active service agent provides this capability.",
    });
    expect(decision.status).toBe("escalated");
    expect(decision.escalationId).toContain("escalation/");
  });

  it("does not route a service agent across organizations", async () => {
    const operations = new CompanyOperationsService(handle.db);
    await operations.registerServiceAgent({
      organizationId: "org/other",
      agentId: "agent/private",
      metadata: { capabilities: ["secret"] },
    });
    const decision = await new CompanyControlPlaneService(handle.db).route({
      organizationId: "org/layer4",
      idempotencyKey: "route/cross-org",
      requestedByAgentId: null,
      targetAgentId: "agent/private",
      departmentId: null,
      requiredRole: null,
      capability: null,
      risk: "low",
      priority: 1,
      title: "Cross organization probe",
      description: "Must not see a service agent from another organization.",
    });
    expect(decision.status).toBe("escalated");
  });
});

function createDbForTest(root: string): DbHandle {
  process.env.AASPAI_DB = `sqlite:${join(root, "state.db")}`;
  return createDb();
}
