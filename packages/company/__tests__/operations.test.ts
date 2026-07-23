import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { closeDefaultDb, getDefaultDb, runMigrations } from "@aaspai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CompanyOperationsError,
  CompanyOperationsService,
  validateAgentHierarchy,
} from "../src/index.js";

const testRoot = resolve("workspace", "m10", "company");
const testDb = join(testRoot, "state.db");
const previousDb = process.env.AASPAI_DB;

describe("company operating extensions", () => {
  beforeAll(async () => {
    await rm(testRoot, { recursive: true, force: true });
    await mkdir(testRoot, { recursive: true });
    process.env.AASPAI_DB = `sqlite:${testDb}`;
    runMigrations(getDefaultDb());
  });

  afterAll(async () => {
    await closeDefaultDb();
    if (previousDb === undefined) delete process.env.AASPAI_DB;
    else process.env.AASPAI_DB = previousDb;
    await rm(testRoot, { recursive: true, force: true });
  });

  it("models departments, service-agent lifecycle, and stale heartbeats", async () => {
    const service = new CompanyOperationsService(getDefaultDb().db);
    const department = await service.createDepartment({
      organizationId: "org_m10",
      name: "Engineering",
    });
    const member = await service.setDepartmentMember({
      organizationId: "org_m10",
      departmentId: department.id,
      agentId: "agent/cto",
      role: "manager",
    });
    expect(member.role).toBe("manager");
    const agent = await service.registerServiceAgent({
      organizationId: "org_m10",
      agentId: "agent/operator",
      departmentId: department.id,
    });
    const stale = await service.reconcileServiceAgents("org_m10", 1, new Date(Date.now() + 5_000));
    expect(stale.map((item) => item.id)).toContain(agent.id);
    expect((await service.heartbeatServiceAgent("org_m10", agent.id)).status).toBe("active");
    expect((await service.transitionServiceAgent("org_m10", agent.id, "paused")).status).toBe(
      "paused",
    );
    expect((await service.transitionServiceAgent("org_m10", agent.id, "active")).status).toBe(
      "active",
    );
    expect((await service.transitionServiceAgent("org_m10", agent.id, "retired")).status).toBe(
      "retired",
    );
    await expect(service.heartbeatServiceAgent("org_m10", agent.id)).rejects.toBeInstanceOf(
      CompanyOperationsError,
    );
  });

  it("requires governed, one-level autonomy proposals and round-trips portable bundles", async () => {
    const service = new CompanyOperationsService(getDefaultDb().db);
    const department = await service.createDepartment({
      organizationId: "org_export",
      name: "Research",
    });
    await service.setDepartmentMember({
      organizationId: "org_export",
      departmentId: department.id,
      agentId: "agent/researcher",
    });
    const proposal = await service.createAutonomyProposal({
      organizationId: "org_export",
      targetType: "loop",
      targetId: "loop/research",
      fromLevel: "L1",
      toLevel: "L2",
      rationale: "Repeated verified runs",
      proposedBy: "user/owner",
    });
    await expect(
      service.createAutonomyProposal({
        organizationId: "org_export",
        targetType: "loop",
        targetId: "loop/research",
        fromLevel: "L0",
        toLevel: "L2",
        rationale: "Too fast",
        proposedBy: "user/owner",
      }),
    ).rejects.toBeInstanceOf(CompanyOperationsError);
    const approved = await service.decideAutonomyProposal(
      "org_export",
      proposal.id,
      "approved",
      "user/owner",
      "Approved for a definition PR",
    );
    expect(approved.status).toBe("approved");
    const bundle = await service.exportCompany("org_export");
    expect(bundle).not.toHaveProperty("organizationId");
    const imported = await service.importCompany("org_imported", bundle);
    expect(imported.organizationId).toBe("org_imported");
    expect(imported.departments).toHaveLength(1);
    expect(imported.autonomyProposals[0]?.status).toBe("approved");
  });
});

describe("agent hierarchy validation", () => {
  it("reports missing managers and cycles", () => {
    expect(
      validateAgentHierarchy([
        { id: "agent/ceo", reportsTo: "agent/missing" },
        { id: "agent/a", reportsTo: "agent/b" },
        { id: "agent/b", reportsTo: "agent/a" },
      ]),
    ).toEqual(
      expect.arrayContaining([
        "agent/ceo reports to missing agent/missing",
        expect.stringContaining("manager cycle"),
      ]),
    );
  });
});
