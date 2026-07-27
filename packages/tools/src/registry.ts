/**
 * Tool registry. Tracks which tools an agent has access to, and
 * enforces the allow/deny/require-approval policy from
 * `agents/<id>/tools.yaml`.
 */
import type { Tool } from "@aaspai/contracts/phase2";
import { getLogger } from "@aaspai/observability";

const log = getLogger("tools.registry");

export interface ToolResolution {
  tool: Tool;
  allowed: boolean;
  ready: boolean;
  requiresApproval: boolean;
  denialReason?: string;
  readinessReason?: string;
}

export class ToolRegistry {
  private readonly byName = new Map<string, Tool>();

  register(tool: Tool): void {
    this.byName.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.byName.delete(name);
  }

  get(name: string): Tool | null {
    return this.byName.get(name) ?? null;
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  list(): readonly Tool[] {
    return [...this.byName.values()];
  }

  describe() {
    return {
      kind: "memory" as const,
      label: "memory:tool-registry",
      detail: { tools: this.byName.size },
    };
  }

  readiness(name: string): { ready: boolean; reason?: string } {
    const tool = this.byName.get(name);
    if (!tool) return { ready: false, reason: "tool not registered" };
    return tool.available === false
      ? { ready: false, reason: tool.unavailableReason ?? "tool unavailable" }
      : { ready: true };
  }

  /**
   * Resolve the set of tools an agent can use, given the agent's
   * tools.yaml config. Respects allow/deny/require_approval_for.
   */
  resolveFor(toolsConfig: {
    allow?: string[];
    deny?: string[];
    require_approval_for?: string[];
  }): ToolResolution[] {
    const allow = new Set(toolsConfig.allow ?? []);
    const deny = new Set(toolsConfig.deny ?? []);
    const requireApproval = new Set(toolsConfig.require_approval_for ?? []);

    const out: ToolResolution[] = [];
    for (const tool of this.byName.values()) {
      if (deny.has(tool.name)) continue;
      if (allow.size > 0 && !allow.has(tool.name)) continue;
      const readiness = this.readiness(tool.name);
      out.push({
        tool,
        allowed: true,
        ready: readiness.ready,
        requiresApproval: requireApproval.has(tool.name),
        ...(readiness.reason ? { readinessReason: readiness.reason } : {}),
      });
    }
    log.debug("resolved tools", { count: out.length, allow: allow.size, deny: deny.size });
    return out;
  }

  /**
   * Invoke a tool by name. The caller's gate layer must have already
   * checked permissions.
   */
  async call(
    name: string,
    input: unknown,
    ctx: unknown,
    options: { allowed?: boolean; approved?: boolean } = {},
  ): Promise<unknown> {
    const tool = this.byName.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    if (tool.available === false)
      throw new Error(`Tool "${name}" is unavailable: ${tool.unavailableReason ?? "not ready"}`);
    if (options.allowed === false) throw new Error(`Tool "${name}" is denied by policy`);
    if (options.approved === false) throw new Error(`Tool "${name}" requires approval`);
    return await tool.execute(input, ctx);
  }
}
