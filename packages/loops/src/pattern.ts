/**
 * Loop pattern — the public type and the registry.
 *
 * A `LoopPattern` is just data: trigger + discover + decide. The
 * scheduler consumes it; nothing else needs to know about it.
 */
import type { DecideResult, LoopPattern, Trigger, WorkItem } from "@aaspai/contracts/phase2";

export type { DecideResult, LoopPattern, Trigger, WorkItem };

export type DiscoverFn = (
  state: unknown,
  ctx: { loopId: string; organizationId: string; now: Date },
) => Promise<readonly WorkItem[]>;
export type DecideFn = (
  item: WorkItem,
  state: unknown,
  ctx: { loopId: string; now: Date },
) => Promise<DecideResult>;

export interface ResolvedLoopPattern {
  pattern: LoopPattern;
  discover: DiscoverFn;
  decide: DecideFn;
}

/**
 * The pattern registry. Holds the resolved patterns (with their
 * discover/decide functions). Foundation ships with the 7 starter
 * patterns; users can register custom ones.
 */
export class PatternRegistry {
  private readonly patterns = new Map<string, ResolvedLoopPattern>();

  register(resolved: ResolvedLoopPattern): void {
    this.patterns.set(resolved.pattern.id, resolved);
  }

  unregister(id: string): void {
    this.patterns.delete(id);
  }

  get(id: string): ResolvedLoopPattern | null {
    return this.patterns.get(id) ?? null;
  }

  list(): readonly LoopPattern[] {
    return [...this.patterns.values()].map((p) => p.pattern);
  }

  resolved(): readonly ResolvedLoopPattern[] {
    return [...this.patterns.values()];
  }
}

/** Apply file-owned policy and schedule metadata to an implementation. */
export function resolveFilePattern(
  pattern: LoopPattern,
  implementation?: ResolvedLoopPattern | null,
): ResolvedLoopPattern {
  if (implementation) return { ...implementation, pattern };
  const config = JSON.parse(pattern.configJson) as Record<string, unknown>;
  const instructions =
    typeof config.instructions === "string" && config.instructions.trim()
      ? config.instructions.trim()
      : pattern.description;
  return {
    pattern,
    discover: async (_state, { now }) => [
      {
        ref: { kind: "loop", id: `${pattern.id}:${now.toISOString()}` },
        title: pattern.title,
        description: instructions,
        discoveredAt: now.toISOString(),
      },
    ],
    decide: async () => ({ kind: "act", reason: instructions }),
  };
}
