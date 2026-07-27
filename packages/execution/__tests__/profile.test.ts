import type { AgentConfig, KnowledgeConcept, Skill } from "@aaspai/contracts/phase2";
import { SkillRegistry } from "@aaspai/skills";
import { ToolRegistry } from "@aaspai/tools";
import { describe, expect, it } from "vitest";
import { compileProfile, hashResolvedAgentProfile } from "../src/profile";

const now = "2026-07-27T00:00:00.000Z";
const agent: AgentConfig = {
  id: "agent/a",
  type: "Agent",
  title: "A",
  description: "A",
  timestamp: now,
  adapter: "dry_run_local",
  role: "general",
  reportsTo: null,
  manages: [],
  peers: [],
  systemPrompt: "system",
  adapterConfig: {},
  runtimeConfig: {},
  runtime: { default: { kind: "local" } },
  tools: {},
  skills: [{ key: "skill/a", version: "1.0.0" }],
  knowledge: { include: ["concept/a"], exclude: [] },
  budget: {},
  relations: {},
};
const skill: Skill = {
  key: "skill/a",
  version: "1.0.0",
  name: "A",
  description: "A",
  instructions: "use it",
  files: [],
  adapterTypes: [],
  owner: "test",
  visibility: "private",
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
};
const concept: KnowledgeConcept = {
  id: "concept/a",
  path: "concept/a.md",
  type: "Doc",
  title: "A",
  description: "A",
  tags: [],
  timestamp: now,
  body: "knowledge",
  appliesToAgents: [],
  appliesToSkills: [],
  related: [],
  hash: "a".repeat(64),
};

function source<T>(value: T, id: string) {
  return {
    async get(requested: string) {
      if (requested !== id) throw new Error("missing");
      return value as never;
    },
    async has(requested: string) {
      return requested === id;
    },
    async list() {
      return [id] as const;
    },
    async search() {
      return [value] as never;
    },
    watch() {
      return () => {};
    },
    describe() {
      return { kind: "test", label: "test" };
    },
  };
}

describe("resolved agent profile", () => {
  it("pins exact skills, knowledge, readiness, and a stable hash", async () => {
    const skills = new SkillRegistry();
    skills.register(skill);
    const profile = await compileProfile({
      organizationId: "org/a",
      agentId: agent.id,
      definitionRevision: {
        id: "revision/a",
        organizationId: "org/a",
        repositoryId: "repo/a",
        commitSha: "1234567",
        sourcePath: ".",
        dirty: false,
        contentHash: "source",
        createdAt: now,
      },
      agentSource: source(agent, agent.id),
      knowledgeSource: source(concept, concept.id),
      skillRegistry: skills,
      toolRegistry: new ToolRegistry(),
      createdAt: now,
    });
    expect(profile.skills[0]?.version).toBe("1.0.0");
    expect(profile.runtime.ready).toBe(true);
    expect(hashResolvedAgentProfile(profile)).toBe(profile.profileHash);
    expect(Object.isFrozen(profile)).toBe(true);
    expect(() => {
      (profile.agent as { title: string }).title = "mutated";
    }).toThrow();
  });

  it("fails before execution when an exact skill is missing", async () => {
    await expect(
      compileProfile({
        organizationId: "org/a",
        agentId: agent.id,
        definitionRevision: {
          id: "revision/a",
          organizationId: "org/a",
          repositoryId: "repo/a",
          commitSha: "1234567",
          sourcePath: ".",
          dirty: false,
          contentHash: "source",
          createdAt: now,
        },
        agentSource: source(agent, agent.id),
        knowledgeSource: source(concept, concept.id),
        skillRegistry: new SkillRegistry(),
        toolRegistry: new ToolRegistry(),
        createdAt: now,
      }),
    ).rejects.toThrow(/Skill not found/);
  });
});
