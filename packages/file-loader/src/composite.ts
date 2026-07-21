import type { ChangeEvent, SourceDescriptor } from "@aaspai/contracts/phase2";

/**
 * Minimum interface a source must satisfy to be composable.
 * The concrete composite classes below narrow this to their port.
 */
interface ComposableSource {
  has(id: string): Promise<boolean>;
  watch(cb: (c: ChangeEvent) => void): () => void;
  describe(): SourceDescriptor;
}

/**
 * `CompositeSource` — the router. Sits in front of N concrete sources
 * and routes each `get/has/list` call to the right backend. The default
 * resolution is priority-based; per-agent overrides are also supported.
 *
 * This is the seam that makes per-agent migration from file → DB
 * possible without breaking anything else.
 */
export interface CompositeOptions<T extends ComposableSource> {
  sources: ReadonlyArray<{ source: T; priority: number }>;
  initialRouting?: Readonly<Record<string, T>>;
}

export class CompositeSource<T extends ComposableSource> {
  protected readonly sources: ReadonlyArray<{ source: T; priority: number; label: string }>;
  protected readonly routing = new Map<string, T>();
  protected readonly callbacks = new Set<(change: ChangeEvent) => void>();
  protected readonly unsubs: Array<() => void> = [];

  constructor(opts: CompositeOptions<T>) {
    this.sources = [...opts.sources]
      .sort((a, b) => b.priority - a.priority)
      .map((s) => ({ ...s, label: s.source.describe().label }));
    if (opts.initialRouting) {
      for (const [id, source] of Object.entries(opts.initialRouting)) {
        this.routing.set(id, source);
      }
    }
  }

  /** Subscribe to all child sources (composite-level watcher). */
  start(): void {
    for (const { source } of this.sources) {
      const unsub = source.watch((change) => this.notify(change));
      this.unsubs.push(unsub);
    }
  }

  stop(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
  }

  /** Route an agent to a specific source. The next `get()` for that id will use it. */
  async route(id: string, source: T): Promise<void> {
    this.routing.set(id, source);
    const change = { kind: "updated" as const, id, at: new Date().toISOString() };
    this.notify(change);
  }

  /** Remove a per-agent routing override (falls back to priority order). */
  async unroute(id: string): Promise<void> {
    this.routing.delete(id);
    const change = { kind: "updated" as const, id, at: new Date().toISOString() };
    this.notify(change);
  }

  /** Where does this id live? (returns the source or null). */
  async resolve(id: string): Promise<T | null> {
    const routed = this.routing.get(id);
    if (routed) {
      if (await routed.has(id)) return routed;
      this.routing.delete(id);
    }
    for (const { source } of this.sources) {
      if (await source.has(id)) return source;
    }
    return null;
  }

  protected async pick(id: string): Promise<T> {
    const resolved = await this.resolve(id);
    if (!resolved) {
      throw new Error(
        `Resource not found in any source: ${id} (sources: ${this.sources.map((s) => s.label).join(", ")})`,
      );
    }
    return resolved;
  }

  protected notify(change: ChangeEvent): void {
    for (const cb of this.callbacks) {
      try {
        cb(change);
      } catch {
        /* swallow */
      }
    }
  }
}

/**
 * Concrete composite for the agent port. Adds the agent-specific
 * get/has/list/watch/describe surface.
 */
import type { AgentConfig, AgentConfigSource } from "@aaspai/contracts/phase2";

export class CompositeAgentConfigSource extends CompositeSource<AgentConfigSource> implements AgentConfigSource {
  async get(id: string): Promise<Readonly<AgentConfig>> {
    const source = await this.pick(id);
    return await source.get(id);
  }
  async has(id: string): Promise<boolean> {
    return (await this.resolve(id)) !== null;
  }
  async list(): Promise<readonly string[]> {
    const all = new Set<string>();
    for (const { source } of this.sources) {
      for (const id of await source.list()) all.add(id);
    }
    return [...all];
  }
  watch(callback: (change: ChangeEvent) => void): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }
  describe(): SourceDescriptor {
    return {
      kind: "composite",
      label: `composite(${this.sources.map((s) => s.label).join(" + ")})`,
      detail: {
        sources: this.sources.map((s) => ({ priority: s.priority, label: s.label })),
        routing: Object.fromEntries(
          [...this.routing.entries()].map(([id, src]) => [id, src.describe().label]),
        ),
      },
    };
  }
}

/** Same shape, for the knowledge port. */
import type { KnowledgeConcept, KnowledgeSource } from "@aaspai/contracts/phase2";

export class CompositeKnowledgeSource extends CompositeSource<KnowledgeSource> implements KnowledgeSource {
  async get(id: string): Promise<Readonly<KnowledgeConcept>> {
    const source = await this.pick(id);
    return await source.get(id);
  }
  async has(id: string): Promise<boolean> {
    return (await this.resolve(id)) !== null;
  }
  async list(): Promise<readonly string[]> {
    const all = new Set<string>();
    for (const { source } of this.sources) {
      for (const id of await source.list()) all.add(id);
    }
    return [...all];
  }
  async search(query: string, opts?: { limit?: number; tags?: string[] }) {
    const merged: KnowledgeConcept[] = [];
    for (const { source } of this.sources) {
      for (const c of await source.search(query, opts)) merged.push(c);
    }
    // Dedup by id
    const seen = new Set<string>();
    const out: KnowledgeConcept[] = [];
    for (const c of merged) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
    }
    return out;
  }
  watch(callback: (change: ChangeEvent) => void): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }
  describe(): SourceDescriptor {
    return {
      kind: "composite",
      label: `composite(${this.sources.map((s) => s.label).join(" + ")})`,
      detail: {
        sources: this.sources.map((s) => ({ priority: s.priority, label: s.label })),
        routing: Object.fromEntries(
          [...this.routing.entries()].map(([id, src]) => [id, src.describe().label]),
        ),
      },
    };
  }
}

/** Same shape, for the loop port. */
import type { LoopPattern, LoopConfigSource } from "@aaspai/contracts/phase2";

export class CompositeLoopConfigSource extends CompositeSource<LoopConfigSource> implements LoopConfigSource {
  async get(id: string): Promise<Readonly<LoopPattern>> {
    const source = await this.pick(id);
    return await source.get(id);
  }
  async has(id: string): Promise<boolean> {
    return (await this.resolve(id)) !== null;
  }
  async list(): Promise<readonly string[]> {
    const all = new Set<string>();
    for (const { source } of this.sources) {
      for (const id of await source.list()) all.add(id);
    }
    return [...all];
  }
  watch(callback: (change: ChangeEvent) => void): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }
  describe(): SourceDescriptor {
    return {
      kind: "composite",
      label: `composite(${this.sources.map((s) => s.label).join(" + ")})`,
      detail: {
        sources: this.sources.map((s) => ({ priority: s.priority, label: s.label })),
        routing: Object.fromEntries(
          [...this.routing.entries()].map(([id, src]) => [id, src.describe().label]),
        ),
      },
    };
  }
}
