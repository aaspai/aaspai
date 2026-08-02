import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "@aaspai/contracts";
import { describe, expect, it } from "vitest";
import {
  companyActionFingerprint,
  hireAndDelegateFingerprint,
  hiredAgentTools,
  repeatsCompletedDelegation,
  WorkerDaemon,
} from "../src/daemon";

describe("hired agent tool inheritance", () => {
  const tools = {
    allow: ["read", "webfetch", "websearch", "browser_snapshot", "company_action"],
    deny: [],
    require_approval_for: [],
  };

  it("gives every employee internet tools and only managers company control", () => {
    expect(hiredAgentTools(tools, { projectRole: "member" }).allow).toEqual([
      "read",
      "webfetch",
      "websearch",
      "browser_snapshot",
    ]);
    expect(hiredAgentTools(tools, { projectRole: "manager" }).allow).toContain("company_action");
  });

  it("recognizes an exact replay of completed delegated work", () => {
    const action = {
      type: "hire_and_delegate" as const,
      agentId: "agent/researcher",
      title: "Researcher",
      role: "researcher" as const,
      description: "Researches customer demand.",
      workTitle: "Validate demand",
      workDescription: "Produce cited evidence.",
      projectId: "project/growth",
      projectRole: "member" as const,
      skillKeys: ["web-research"],
      citationPaths: ["evidence/sources.md"],
    };
    const completed = {
      assignedAgentId: "agent/researcher",
      title: "Validate demand",
      description: "Produce cited evidence.",
      projectId: "project/growth",
      metadata: {
        delegationActionFingerprint: hireAndDelegateFingerprint(action, "project/growth"),
      },
      status: "completed" as const,
    };

    expect(repeatsCompletedDelegation(action, completed)).toBe(true);
    expect(repeatsCompletedDelegation({ ...action, workTitle: "Test pricing" }, completed)).toBe(
      false,
    );
    expect(
      repeatsCompletedDelegation({ ...action, description: "A different profile." }, completed),
    ).toBe(false);
    expect(
      repeatsCompletedDelegation({ ...action, citationPaths: ["evidence/other.md"] }, completed),
    ).toBe(false);
  });

  it("separates distinct one-action broker calls without depending on call index", () => {
    const first = {
      type: "create_milestone" as const,
      projectId: "project/growth",
      title: "First outcome",
      outcome: "One",
      sequence: 1,
      acceptance: { evidence: true, count: 1 },
    };
    expect(companyActionFingerprint(first, first.projectId)).toBe(
      companyActionFingerprint(
        { ...first, acceptance: { count: 1, evidence: true } },
        first.projectId,
      ),
    );
    expect(companyActionFingerprint(first, first.projectId)).not.toBe(
      companyActionFingerprint({ ...first, title: "Second outcome" }, first.projectId),
    );
  });

  it("only reuses an employee for its manager and repairs the reverse relation", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaspai-hired-agent-"));
    const previousAgentsDir = process.env.AASPAI_AGENTS_DIR;
    const previousDb = process.env.AASPAI_DB;
    process.env.AASPAI_AGENTS_DIR = root;
    process.env.AASPAI_DB = `sqlite:${join(root, "state.db")}`;
    try {
      await mkdir(join(root, "manager"), { recursive: true });
      await mkdir(join(root, "researcher"), { recursive: true });
      await mkdir(join(root, "analyst"), { recursive: true });
      for (const slug of ["researcher", "analyst"]) {
        for (const file of [
          "AGENT.md",
          "config.yaml",
          "relations.yaml",
          "skills.lock.json",
          "tools.yaml",
        ]) {
          await writeFile(join(root, slug, file), `${file}\n`, "utf8");
        }
      }
      const manager = {
        id: "agent/manager",
        reportsTo: null,
        manages: [],
        peers: ["agent/peer"],
      } as unknown as Readonly<AgentConfig>;
      let reportsTo: string | null = manager.id;
      const daemon = new WorkerDaemon({ organizationId: "org_test" });
      const privateDaemon = daemon as unknown as {
        agentSource: {
          has(id: string): Promise<boolean>;
          get(id: string): Promise<Readonly<AgentConfig>>;
        };
        writeHiredAgent(
          action: Record<string, unknown>,
          manager: Readonly<AgentConfig>,
        ): Promise<unknown>;
      };
      privateDaemon.agentSource = {
        async has() {
          return true;
        },
        async get() {
          return {
            title: "Researcher",
            role: "researcher",
            reportsTo,
          } as unknown as Readonly<AgentConfig>;
        },
      };
      const action = {
        type: "hire_and_delegate",
        agentId: "agent/researcher",
        title: "Researcher",
        role: "researcher",
        description: "Research markets",
        workTitle: "Research demand",
        workDescription: "Return evidence",
      };

      await privateDaemon.writeHiredAgent(action, manager);
      await privateDaemon.writeHiredAgent({ ...action, agentId: "agent/analyst" }, manager);
      await expect(readFile(join(root, "manager", "relations.yaml"), "utf8")).resolves.toBe(
        'reportsTo: null\nmanages: ["agent/researcher","agent/analyst"]\npeers: ["agent/peer"]\n',
      );

      reportsTo = "agent/other-manager";
      await expect(privateDaemon.writeHiredAgent(action, manager)).rejects.toThrow(
        "reports to agent/other-manager",
      );
    } finally {
      const { closeDefaultDb } = await import("@aaspai/db");
      await closeDefaultDb();
      if (previousAgentsDir === undefined) delete process.env.AASPAI_AGENTS_DIR;
      else process.env.AASPAI_AGENTS_DIR = previousAgentsDir;
      if (previousDb === undefined) delete process.env.AASPAI_DB;
      else process.env.AASPAI_DB = previousDb;
      await rm(root, { recursive: true, force: true });
    }
  });
});
