import { createHash } from "node:crypto";
import type {
  AgentConfig,
  AgentConfigSource,
  DefinitionRevision,
  KnowledgeSource,
  Skill,
} from "@aaspai/contracts";
import {
  freezeResolvedAgentProfile,
  type ResolvedAgentProfile,
  resolvedAgentProfileSchema,
} from "@aaspai/contracts/profile";
import { type ExecutionTarget, executionTargetSchema } from "@aaspai/contracts/runtime";
import { getAdapter } from "@aaspai/harness";
import { KnowledgeLoader } from "@aaspai/knowledge";
import { listRuntimeTargets } from "@aaspai/runtime";
import type { SkillRegistry } from "@aaspai/skills";
import type { ToolRegistry } from "@aaspai/tools";
import { assertRuntimeReady } from "./capabilities.js";

export interface CompileProfileInput {
  organizationId: string;
  agentId: string;
  definitionRevision: DefinitionRevision;
  agentSource: AgentConfigSource;
  knowledgeSource: KnowledgeSource;
  skillRegistry: SkillRegistry;
  toolRegistry: ToolRegistry;
  adapter?: string;
  target?: ExecutionTarget;
  prompt?: string;
  runtimeBaseDir?: string;
  createdAt?: string;
}

/** Compile all mutable definitions into one self-contained autonomous snapshot. */
export async function compileProfile(input: CompileProfileInput): Promise<ResolvedAgentProfile> {
  const agent = await input.agentSource.get(input.agentId);
  const adapter = input.adapter ?? agent.adapter;
  const adapterInfo = getAdapter(adapter as never).info;
  if (adapterInfo.status !== "ready") throw new Error(`Harness ${adapter} is unavailable`);

  const target = resolveAgentTarget(agent, input.target);
  const runtimeInfo = runtimeLabel(target);
  if (runtimeInfo.status !== "ready")
    throw new Error(`Runtime ${runtimeInfo.label} is unavailable`);
  await assertRuntimeReady(target);

  const skills = await resolveSkills(agent, input.skillRegistry, adapter);
  const knowledgeLoader = new KnowledgeLoader({ source: input.knowledgeSource });
  const knowledge = await knowledgeLoader.loadFor(agent);
  const knownKnowledge = new Set(await input.knowledgeSource.list());
  for (const ref of [
    ...stringArray(agent.knowledge.include),
    ...stringArray(agent.knowledge.exclude),
  ]) {
    if (!ref.includes("*") && !knownKnowledge.has(ref)) {
      throw new Error(`Knowledge concept not found: ${ref}`);
    }
  }
  const toolDecisions = resolveTools(agent, input.toolRegistry);
  const unresolved = toolDecisions.find((decision) => !decision.allowed || !decision.ready);
  if (unresolved) {
    throw new Error(
      `Tool ${unresolved.name} is unavailable: ${unresolved.denialReason ?? unresolved.readinessReason ?? "denied"}`,
    );
  }

  const base = {
    schemaVersion: 1 as const,
    profileHash: "0".repeat(64),
    organizationId: input.organizationId,
    agentId: input.agentId,
    definitionRevision: input.definitionRevision,
    createdAt: input.createdAt ?? new Date().toISOString(),
    sources: {
      agent: input.agentSource.describe(),
      skills: input.skillRegistry.describe(),
      knowledge: input.knowledgeSource.describe(),
    },
    agent,
    skills,
    knowledge: {
      include: stringArray(agent.knowledge.include),
      exclude: stringArray(agent.knowledge.exclude),
      concepts: [...knowledge.concepts.values()],
      context: knowledge.context,
      contentHash: sha256(
        canonicalJson(
          [...knowledge.concepts.values()].map((concept) => ({
            id: concept.id,
            hash: concept.hash,
          })),
        ),
      ),
    },
    tools: toolDecisions,
    runtime: {
      target,
      ready: true,
      identity: runtimeInfo.label,
    },
    harness: { adapter, ready: true },
    materialization: {
      adapterType: adapter,
      files: skills.flatMap((resolved) =>
        resolved.skill.files.map((file) => ({
          path: `${resolved.key}/${file.path}`,
          sha256: file.sha256 ?? sha256(file.content),
        })),
      ),
    },
    inputs: {
      prompt: input.prompt ?? agent.systemPrompt,
      adapterConfig: { ...(agent.model ? { model: agent.model } : {}), ...agent.adapterConfig },
      runtimeConfig: agent.runtimeConfig,
      budget: agent.budget,
      toolPolicy: agent.tools,
      knowledgeScope: agent.knowledge,
    },
  };
  const profileHash = sha256(canonicalJson({ ...base, profileHash: undefined }));
  return freezeResolvedAgentProfile(resolvedAgentProfileSchema.parse({ ...base, profileHash }));
}

export function hashResolvedAgentProfile(profile: ResolvedAgentProfile): string {
  const { profileHash: _ignored, ...content } = profile;
  return sha256(canonicalJson({ ...content, profileHash: undefined }));
}

async function resolveSkills(agent: AgentConfig, registry: SkillRegistry, adapter: string) {
  const result: ResolvedAgentProfile["skills"] = [];
  for (const ref of agent.skills) {
    const skill = registry.get(ref.key, ref.version);
    if (!skill) throw new Error(`Skill not found: ${ref.key}@${ref.version}`);
    if (skill.archivedAt) throw new Error(`Skill is archived: ${ref.key}@${ref.version}`);
    if (skill.adapterTypes.length > 0 && !skill.adapterTypes.includes(adapter)) {
      throw new Error(`Skill ${ref.key}@${ref.version} does not support ${adapter}`);
    }
    for (const file of skill.files) {
      if (file.sha256 && sha256(file.content) !== file.sha256.toLowerCase()) {
        throw new Error(`Skill file hash mismatch: ${ref.key}@${ref.version} ${file.path}`);
      }
    }
    result.push({ key: ref.key, version: ref.version, contentHash: skillHash(skill), skill });
  }
  return result.sort((a, b) => `${a.key}@${a.version}`.localeCompare(`${b.key}@${b.version}`));
}

function resolveTools(agent: AgentConfig, registry: ToolRegistry): ResolvedAgentProfile["tools"] {
  const config = agent.tools as { allow?: unknown; deny?: unknown; require_approval_for?: unknown };
  const allow = stringArray(config.allow);
  const deny = new Set(stringArray(config.deny));
  const approval = new Set(stringArray(config.require_approval_for));
  const names = allow.length > 0 ? allow : registry.list().map((tool) => tool.name);
  return names.sort().map((name) => {
    const tool = registry.get(name);
    if (!tool)
      return {
        name,
        allowed: false,
        ready: false,
        denialReason: "tool not registered",
        requiresApproval: approval.has(name),
      };
    if (deny.has(name))
      return {
        name,
        allowed: false,
        ready: false,
        denialReason: "tool denied by policy",
        requiresApproval: approval.has(name),
      };
    const readiness = registry.readiness(name);
    return {
      name,
      allowed: true,
      ready: readiness.ready,
      requiresApproval: approval.has(name),
      ...(readiness.reason ? { readinessReason: readiness.reason } : {}),
      tool: { name: tool.name, description: tool.description, risk: tool.risk },
    };
  });
}

function resolveAgentTarget(agent: AgentConfig, target?: ExecutionTarget): ExecutionTarget {
  const configured = target ?? agent.runtime.default ?? agent.runtime;
  const parsed = executionTargetSchema.safeParse(configured);
  if (!parsed.success) throw new Error("Agent runtime.default must be a valid execution target");
  return parsed.data;
}

function runtimeLabel(target: ExecutionTarget) {
  const label = target.kind === "sandbox" ? `${target.kind}:${target.provider}` : target.kind;
  const info = listRuntimeTargets().find(
    (item) =>
      item.kind === target.kind && (target.kind !== "sandbox" || item.provider === target.provider),
  );
  return { label, status: info?.status ?? "stub" };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function skillHash(skill: Skill): string {
  return sha256(
    canonicalJson({
      ...skill,
      files: skill.files.map(({ path, content, kind, sha256: declared }) => ({
        path,
        content,
        kind,
        sha256: declared,
      })),
    }),
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
