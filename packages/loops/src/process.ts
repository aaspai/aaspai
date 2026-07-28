import { createHash } from "node:crypto";
import {
  type ProcessStep as ContractProcessStep,
  type ProcessDefinition,
  processDefinitionSchema,
} from "@aaspai/contracts/operator";
import type { LoopPattern } from "@aaspai/contracts/phase2";

export type ProcessFailureAction = "stop" | "continue" | "retry" | "escalate";

export interface ProcessStep {
  id: string;
  agent: string | null;
  routingRule?: ContractProcessStep["routingRule"];
  dependsOn: string[];
  prompt?: string;
  skills?: string[];
  tools?: string[];
  timeoutMs: number;
  maxAttempts: number;
  acceptanceCriteria: string;
  failureAction: ProcessFailureAction;
  approvalPolicy?: Record<string, unknown>;
}

export interface CompiledProcess {
  steps: readonly ProcessStep[];
  order: readonly string[];
  maxAttempts: number;
  maxDurationMs: number;
  contentHash?: string;
}

export interface ProcessDefinitionInput
  extends Omit<ProcessDefinition, "contentHash" | "createdAt" | "maxAttempts" | "maxDurationMs"> {
  contentHash?: string;
  createdAt?: string;
  maxAttempts?: number;
  maxDurationMs?: number;
}

/** Validate a file-defined process once and return its immutable, hashed DAG snapshot. */
export function compileProcessDefinition(input: unknown): ProcessDefinition & CompiledProcess {
  const raw = input as Partial<ProcessDefinitionInput>;
  const steps = Array.isArray(raw.steps) ? raw.steps : [];
  const canonical = JSON.stringify({ ...raw, contentHash: undefined, createdAt: undefined });
  const contentHash = createHash("sha256").update(canonical).digest("hex");
  const now = new Date().toISOString();
  const definition = processDefinitionSchema.parse({
    ...raw,
    contentHash,
    createdAt: raw.createdAt ?? now,
    maxAttempts:
      raw.maxAttempts ??
      steps.reduce(
        (total, step) =>
          total +
          (typeof step === "object" && step
            ? Number((step as Record<string, unknown>).maxAttempts)
            : 0),
        0,
      ),
    maxDurationMs:
      raw.maxDurationMs ??
      steps.reduce(
        (total, step) =>
          total +
          (typeof step === "object" && step
            ? Number((step as Record<string, unknown>).timeoutMs)
            : 0),
        0,
      ),
  });
  const compiled = compileSteps(definition.steps);
  return {
    ...definition,
    order: compiled.order,
    maxAttempts: compiled.maxAttempts,
    maxDurationMs: compiled.maxDurationMs,
    contentHash,
  };
}

/** Compile the first deliberately small process format: a bounded static DAG. */
export function compileProcess(loop: LoopPattern): CompiledProcess {
  const raw = parseConfig(loop.configJson);
  const value = isRecord(raw.process) ? raw.process : raw;
  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    throw new Error("Process must define a non-empty steps array");
  }
  const ids = new Set<string>();
  const steps: ProcessStep[] = value.steps.map((rawStep, index) => {
    if (!isRecord(rawStep)) throw new Error(`Process step ${index} must be an object`);
    const id = stringValue(rawStep.id);
    const agent = stringValue(rawStep.agent);
    const timeoutMs = integerValue(rawStep.timeoutMs);
    const maxAttempts = integerValue(rawStep.maxAttempts);
    const acceptanceCriteria = stringValue(rawStep.acceptanceCriteria);
    const failureAction = stringValue(rawStep.failureAction) as ProcessFailureAction;
    if (!id || ids.has(id))
      throw new Error(`Process step ${id || index} has a missing or duplicate id`);
    if (!agent) throw new Error(`Process step ${id || index} is missing agent`);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000)
      throw new Error(`Process step ${id} has an invalid timeoutMs`);
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100)
      throw new Error(`Process step ${id} has an invalid maxAttempts`);
    if (!acceptanceCriteria) throw new Error(`Process step ${id} is missing acceptanceCriteria`);
    if (!["stop", "continue", "retry", "escalate"].includes(failureAction))
      throw new Error(`Process step ${id} has an invalid failureAction`);
    ids.add(id);
    return {
      id,
      agent,
      routingRule: null,
      dependsOn: stringArray(rawStep.dependsOn).sort(),
      prompt: stringValue(rawStep.prompt),
      skills: stringArray(rawStep.skills).sort(),
      tools: stringArray(rawStep.tools).sort(),
      timeoutMs,
      maxAttempts,
      acceptanceCriteria,
      failureAction,
      approvalPolicy: isRecord(rawStep.approvalPolicy) ? rawStep.approvalPolicy : {},
    };
  });
  for (const step of steps)
    for (const dependency of step.dependsOn)
      if (!ids.has(dependency))
        throw new Error(`Process step ${step.id} depends on unknown step ${dependency}`);

  const order: string[] = [];
  const remaining = new Map(steps.map((step) => [step.id, new Set(step.dependsOn)]));
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, deps]) => deps.size === 0)
      .map(([id]) => id)
      .sort();
    if (ready.length === 0) throw new Error("Process steps contain a dependency cycle");
    for (const id of ready) {
      order.push(id);
      remaining.delete(id);
      for (const deps of remaining.values()) deps.delete(id);
    }
  }
  return {
    steps: order.map((id) => steps.find((step) => step.id === id) as ProcessStep),
    order,
    maxAttempts: steps.reduce((total, step) => total + step.maxAttempts, 0),
    maxDurationMs: steps.reduce((total, step) => total + step.timeoutMs, 0),
  };
}

function compileSteps(source: readonly ContractProcessStep[]): CompiledProcess {
  const ids = new Set<string>();
  for (const step of source) {
    if (ids.has(step.id)) throw new Error(`Process step ${step.id} has a duplicate id`);
    ids.add(step.id);
  }
  for (const step of source) {
    for (const dependency of step.dependsOn) {
      if (dependency === step.id)
        throw new Error(`Process step ${step.id} cannot depend on itself`);
      if (!ids.has(dependency))
        throw new Error(`Process step ${step.id} depends on unknown step ${dependency}`);
    }
  }
  const remaining = new Map(source.map((step) => [step.id, new Set(step.dependsOn)]));
  const order: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([id]) => id)
      .sort();
    if (ready.length === 0) throw new Error("Process steps contain a dependency cycle");
    for (const id of ready) {
      order.push(id);
      remaining.delete(id);
      for (const dependencies of remaining.values()) dependencies.delete(id);
    }
  }
  return {
    order,
    steps: order.map((id) => {
      const step = source.find((candidate) => candidate.id === id) as ContractProcessStep;
      return {
        id: step.id,
        agent: step.agent ?? "",
        routingRule: step.routingRule,
        dependsOn: [...step.dependsOn].sort(),
        prompt: step.prompt,
        skills: [...step.skills].sort(),
        tools: [...step.tools].sort(),
        timeoutMs: step.timeoutMs,
        maxAttempts: step.maxAttempts,
        acceptanceCriteria: step.acceptanceCriteria,
        failureAction: step.failureAction,
        approvalPolicy: step.approvalPolicy,
      };
    }),
    maxAttempts: source.reduce((total, step) => total + step.maxAttempts, 0),
    maxDurationMs: source.reduce((total, step) => total + step.timeoutMs, 0),
  };
}

function parseConfig(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) throw new Error("config must be an object");
    return parsed;
  } catch (error) {
    throw new Error(
      `Invalid process config: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function integerValue(value: unknown): number {
  return typeof value === "number" ? value : Number.NaN;
}
