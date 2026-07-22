import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  type ChangeEvent,
  type KnowledgeConcept,
  type KnowledgeSource,
  knowledgeConceptSchema,
  type SourceDescriptor,
} from "@aaspai/contracts/phase2";
import { getLogger } from "@aaspai/observability";
import { FileWatcher } from "./chokidar-watcher.js";
import { parseOkfFile, sha256HexSync } from "./okf-parser.js";

const log = getLogger("file-loader.knowledge-source");

/**
 * File-based `KnowledgeSource`. Reads OKF-compliant markdown files from
 * a knowledge directory (default `./knowledge`).
 */
export class FileKnowledgeSource implements KnowledgeSource {
  private readonly cache = new Map<string, Readonly<KnowledgeConcept>>();
  private readonly watcher: FileWatcher;
  private rescanInterval: NodeJS.Timeout | null = null;
  private watching = false;
  private readonly callbacks = new Set<(change: ChangeEvent) => void>();

  constructor(private readonly knowledgeDir: string) {
    this.watcher = new FileWatcher(knowledgeDir);
  }

  async start(): Promise<void> {
    if (this.watching) return;
    this.watching = true;
    this.watcher.on("changed", (event) => {
      this.handleChange(event.path, event.kind).catch((err) =>
        log.error("watcher change failed", { path: event.path, err: String(err) }),
      );
    });
    this.watcher.start();
    await new Promise<void>((resolve) => {
      if (this.watcher.isReady()) resolve();
      else this.watcher.once("ready", () => resolve());
    });
    await this.scanAll();
    this.rescanInterval = setInterval(() => {
      this.scanAll().catch((err) => log.error("rescan failed", { err: String(err) }));
    }, 60_000);
    this.rescanInterval.unref();
    log.info("FileKnowledgeSource started", { dir: this.knowledgeDir, concepts: this.cache.size });
  }

  async stop(): Promise<void> {
    this.watching = false;
    if (this.rescanInterval) {
      clearInterval(this.rescanInterval);
      this.rescanInterval = null;
    }
    await this.watcher.stop();
  }

  async get(id: string): Promise<Readonly<KnowledgeConcept>> {
    const concept = this.cache.get(id);
    if (!concept) {
      throw new Error(`Unknown knowledge concept: ${id} (loaded: ${this.cache.size})`);
    }
    return concept;
  }

  async has(id: string): Promise<boolean> {
    return this.cache.has(id);
  }

  async list(): Promise<readonly string[]> {
    return [...this.cache.keys()];
  }

  async search(
    query: string,
    opts: { limit?: number; tags?: string[] } = {},
  ): Promise<readonly KnowledgeConcept[]> {
    const limit = opts.limit ?? 25;
    const q = query.toLowerCase();
    const tagFilter = opts.tags ? new Set(opts.tags) : null;
    const results: Array<{ score: number; concept: Readonly<KnowledgeConcept> }> = [];
    for (const concept of this.cache.values()) {
      if (tagFilter && !concept.tags.some((t) => tagFilter.has(t))) continue;
      const score = scoreMatch(concept, q);
      if (score > 0) results.push({ score, concept });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit).map((r) => r.concept);
  }

  watch(callback: (change: ChangeEvent) => void): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  describe(): SourceDescriptor {
    return {
      kind: "file",
      label: `file:${this.knowledgeDir}`,
      detail: { concepts: this.cache.size },
    };
  }

  // ── Internals ────────────────────────────────────────────────
  private async scanAll(): Promise<void> {
    const files = await this.walkMd(this.knowledgeDir);
    const next = new Map<string, Readonly<KnowledgeConcept>>();
    for (const filePath of files) {
      try {
        const concept = await this.loadFile(filePath);
        if (concept) next.set(concept.id, concept);
      } catch (err) {
        log.warn("failed to load knowledge", { path: filePath, err: String(err) });
      }
    }
    const added: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];
    for (const [id, c] of next) {
      const prev = this.cache.get(id);
      if (!prev) added.push(id);
      else if (prev.hash !== c.hash) updated.push(id);
    }
    for (const id of this.cache.keys()) {
      if (!next.has(id)) removed.push(id);
    }
    this.cache.clear();
    for (const [k, v] of next) this.cache.set(k, v);
    for (const id of added) this.emitChange({ kind: "added", id, at: nowIso() });
    for (const id of updated) this.emitChange({ kind: "updated", id, at: nowIso() });
    for (const id of removed) this.emitChange({ kind: "removed", id, at: nowIso() });
  }

  private async handleChange(path: string, kind: "added" | "updated" | "removed"): Promise<void> {
    if (!path.endsWith(".md")) return;
    if (kind === "removed") {
      const id = this.pathToId(path);
      if (!this.cache.has(id)) return;
      this.cache.delete(id);
      this.emitChange({ kind: "removed", id, at: nowIso() });
      return;
    }
    const concept = await this.loadFile(path);
    if (!concept) return;
    const prev = this.cache.get(concept.id);
    this.cache.set(concept.id, concept);
    this.emitChange({ kind: prev ? "updated" : "added", id: concept.id, at: nowIso() });
  }

  private async walkMd(dir: string): Promise<string[]> {
    const out: string[] = [];
    let entries: { name: string; isDirectory: () => boolean }[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...(await this.walkMd(full)));
      } else if (entry.name.endsWith(".md")) {
        out.push(full);
      }
    }
    return out;
  }

  private pathToId(path: string): string {
    const rel = relative(this.knowledgeDir, path).split(sep).join("/");
    return rel.replace(/\.md$/, "");
  }

  private async loadFile(filePath: string): Promise<Readonly<KnowledgeConcept> | null> {
    const raw = await readFile(filePath, "utf8");
    const parsed = parseOkfFile(raw, { filePath });
    const fm = parsed.frontmatter as Record<string, unknown>;
    const id = this.pathToId(filePath);
    const concept: KnowledgeConcept = {
      id,
      path: filePath,
      type: (fm.type as string) ?? "Doc",
      title: fm.title as string,
      description: fm.description as string,
      tags: (fm.tags as string[]) ?? [],
      timestamp: fm.timestamp as string,
      body: parsed.body,
      confidence: fm.confidence as "low" | "medium" | "high" | undefined,
      appliesToAgents:
        (fm.appliesToAgents as string[]) ?? (fm.applies_to as { agents?: string[] })?.agents ?? [],
      appliesToSkills:
        (fm.appliesToSkills as string[]) ?? (fm.applies_to as { skills?: string[] })?.skills ?? [],
      related: (fm.related as string[]) ?? [],
      lastUpdatedBy: (fm.lastUpdatedBy as string) ?? (fm.last_updated_by as string),
      lastUpdatedAt: (fm.lastUpdatedAt as string) ?? (fm.last_updated_at as string),
      hash: parsed.hash,
    };
    return knowledgeConceptSchema.parse(concept) as Readonly<KnowledgeConcept>;
  }

  private emitChange(change: ChangeEvent): void {
    for (const cb of this.callbacks) {
      try {
        cb(change);
      } catch (err) {
        log.warn("change callback threw", { err: String(err) });
      }
    }
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function scoreMatch(c: Readonly<KnowledgeConcept>, q: string): number {
  if (!q) return 1; // empty query → all
  let score = 0;
  const title = c.title.toLowerCase();
  const desc = c.description.toLowerCase();
  if (title.includes(q)) score += 10;
  if (desc.includes(q)) score += 5;
  for (const tag of c.tags) if (tag.toLowerCase().includes(q)) score += 3;
  if (c.body.toLowerCase().includes(q)) score += 1;
  // Use hash for tiebreak
  return score;
}

// re-export sha256HexSync so other modules in the package can use it
export { sha256HexSync };
