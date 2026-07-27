import type { LoopPattern } from "@aaspai/contracts/phase2";

export type ProcessFailureAction = "stop" | "continue" | "retry" | "escalate";

export interface ProcessStep {
  id: string;
  agent: string;
  dependsOn: string[];
  timeoutMs: number;
  maxAttempts: number;
  acceptanceCriteria: string;
  failureAction: ProcessFailureAction;
}

export interface CompiledProcess {
  steps: readonly ProcessStep[];
  order: readonly string[];
  maxAttempts: number;
  maxDurationMs: number;
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
      dependsOn: stringArray(rawStep.dependsOn).sort(),
      timeoutMs,
      maxAttempts,
      acceptanceCriteria,
      failureAction,
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
