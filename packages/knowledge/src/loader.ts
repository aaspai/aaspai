/**
 * Loads an agent's knowledge subset for a session.
 *
 * Given an agent's `knowledge` block (include / exclude lists of
 * OKF concept paths), resolve which concepts apply and return them
 * as markdown bodies that can be injected into the agent's context.
 */
import type { AgentConfig } from "@aaspai/contracts/phase2";
import type { KnowledgeConcept, KnowledgeSource } from "@aaspai/contracts/phase2";
import { getLogger } from "@aaspai/observability";

const log = getLogger("knowledge.loader");

export interface LoadedKnowledge {
  /** The resolved concept paths that were actually loaded. */
  paths: readonly string[];
  /** The full concepts (bodies included) for each resolved path. */
  concepts: ReadonlyMap<string, Readonly<KnowledgeConcept>>;
  /** Concatenated markdown body, ready to inject into a system prompt. */
  context: string;
}

export interface KnowledgeLoaderOptions {
  source: KnowledgeSource;
  /** Max concepts to load per agent (default 50). */
  maxConcepts?: number;
  /** Max characters in the concatenated context (default 100_000). */
  maxContextChars?: number;
}

export class KnowledgeLoader {
  private readonly maxConcepts: number;
  private readonly maxContextChars: number;

  constructor(private readonly opts: KnowledgeLoaderOptions) {
    this.maxConcepts = opts.maxConcepts ?? 50;
    this.maxContextChars = opts.maxContextChars ?? 100_000;
  }

  /**
   * Resolve the agent's knowledge scope and load the matching
   * concepts from the source.
   */
  async loadFor(agent: AgentConfig): Promise<LoadedKnowledge> {
    const include = asStringArray(agent.knowledge["include"]);
    const exclude = new Set(asStringArray(agent.knowledge["exclude"]));
    const concepts = new Map<string, Readonly<KnowledgeConcept>>();

    for (const pattern of include) {
      const matches = await this.expandPattern(pattern, exclude);
      for (const id of matches) {
        if (concepts.size >= this.maxConcepts) {
          log.warn("knowledge cap hit", { agentId: agent.id, max: this.maxConcepts });
          break;
        }
        if (concepts.has(id)) continue;
        if (await this.opts.source.has(id)) {
          const concept = await this.opts.source.get(id);
          concepts.set(id, concept);
        }
      }
    }

    const context = this.buildContext(concepts);
    return { paths: [...concepts.keys()], concepts, context };
  }

  private async expandPattern(
    pattern: string,
    exclude: Set<string>,
  ): Promise<string[]> {
    if (!pattern.includes("*")) {
      return exclude.has(pattern) ? [] : [pattern];
    }
    // Glob expansion: list all concepts and filter
    const all = await this.opts.source.list();
    const regex = globToRegex(pattern);
    return all.filter((id) => !exclude.has(id) && regex.test(id));
  }

  private buildContext(concepts: ReadonlyMap<string, Readonly<KnowledgeConcept>>): string {
    if (concepts.size === 0) return "";
    const parts: string[] = ["# Knowledge", ""];
    let total = 0;
    for (const [id, concept] of concepts) {
      const block = `## ${concept.title} (${id})\n\n${concept.body}\n`;
      if (total + block.length > this.maxContextChars) {
        parts.push(`\n_(knowledge truncated at ${this.maxContextChars} chars)_`);
        break;
      }
      parts.push(block);
      total += block.length;
    }
    return parts.join("\n");
  }
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

function globToRegex(pattern: string): RegExp {
  // Simple glob: * matches any chars except /, ** matches any chars
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLESTAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLESTAR::/g, ".*");
  return new RegExp(`^${escaped}$`);
}
