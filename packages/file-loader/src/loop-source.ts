import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  budgetSchema,
  type ChangeEvent,
  gatePolicySchema,
  type LoopConfigSource,
  type LoopPattern,
  loopPatternSchema,
  type SourceDescriptor,
} from "@aaspai/contracts/phase2";
import { getLogger } from "@aaspai/observability";
import * as yaml from "js-yaml";
import { FileWatcher } from "./chokidar-watcher.js";
import { parseOkfFile, sha256HexSync } from "./okf-parser.js";

const log = getLogger("file-loader.loop-source");

/**
 * File-based `LoopConfigSource`. Reads `.aaspai/loops/<slug>/LOOP.md` (OKF
 * frontmatter) plus the optional sidecar files (`gate.yaml`,
 * `budget.yaml`). Scheduling is defined once in `LOOP.md` frontmatter.
 */
export class FileLoopConfigSource implements LoopConfigSource {
  private readonly cache = new Map<string, Readonly<LoopPattern>>();
  private readonly byHash = new Map<string, Readonly<LoopPattern>>();
  private readonly watcher: FileWatcher;
  private rescanInterval: NodeJS.Timeout | null = null;
  private watching = false;
  private readonly callbacks = new Set<(change: ChangeEvent) => void>();

  constructor(private readonly loopsDir: string) {
    this.watcher = new FileWatcher(loopsDir);
  }

  async start(): Promise<void> {
    if (this.watching) return;
    this.watching = true;
    this.watcher.on("changed", (event) => {
      this.handleChange(event.path, event.kind).catch((err) => {
        const dir = this.dirOf(event.path);
        const id = dir ? `loop/${basename(dir)}` : null;
        if (id && this.cache.delete(id)) this.emitChange({ kind: "removed", id, at: nowIso() });
        log.error("watcher change failed; loop disabled", {
          path: event.path,
          id,
          err: String(err),
        });
      });
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
    log.info("FileLoopConfigSource started", { dir: this.loopsDir, loops: this.cache.size });
  }

  async stop(): Promise<void> {
    this.watching = false;
    if (this.rescanInterval) {
      clearInterval(this.rescanInterval);
      this.rescanInterval = null;
    }
    await this.watcher.stop();
  }

  async get(id: string): Promise<Readonly<LoopPattern>> {
    const loop = this.cache.get(id);
    if (!loop) {
      throw new Error(`Unknown loop: ${id} (loaded: ${[...this.cache.keys()].join(", ")})`);
    }
    return loop;
  }

  async has(id: string): Promise<boolean> {
    return this.cache.has(id);
  }

  async list(): Promise<readonly string[]> {
    return [...this.cache.keys()];
  }

  watch(callback: (change: ChangeEvent) => void): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  describe(): SourceDescriptor {
    return {
      kind: "file",
      label: `file:${this.loopsDir}`,
      detail: { loops: this.cache.size },
    };
  }

  // ── Internals ────────────────────────────────────────────────
  private async scanAll(): Promise<void> {
    const next = new Map<string, Readonly<LoopPattern>>();
    let entries: { name: string; isDirectory: () => boolean }[];
    try {
      entries = await readdir(this.loopsDir, { withFileTypes: true });
    } catch (err) {
      log.warn("loops dir not readable", { dir: this.loopsDir, err: String(err) });
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const dir = join(this.loopsDir, entry.name);
      try {
        const loop = await this.loadLoopDir(dir);
        if (loop) next.set(loop.id, loop);
      } catch (err) {
        log.error("failed to load loop", { dir, err: String(err) });
      }
    }
    const added: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];
    for (const [id, l] of next) {
      const prev = this.cache.get(id);
      if (!prev) added.push(id);
      else if (prev !== l) updated.push(id);
    }
    for (const id of this.cache.keys()) {
      if (!next.has(id)) removed.push(id);
    }
    this.cache.clear();
    this.byHash.clear();
    for (const [k, v] of next) {
      this.cache.set(k, v);
      this.byHash.set(sha256HexSync(JSON.stringify(v)), v);
    }
    for (const id of added) this.emitChange({ kind: "added", id, at: nowIso() });
    for (const id of updated) this.emitChange({ kind: "updated", id, at: nowIso() });
    for (const id of removed) this.emitChange({ kind: "removed", id, at: nowIso() });
  }

  private async handleChange(path: string, kind: "added" | "updated" | "removed"): Promise<void> {
    const dir = this.dirOf(path);
    if (!dir) return;
    if (kind === "removed") {
      const id = `loop/${basename(dir)}`;
      if (!this.cache.has(id)) return;
      this.cache.delete(id);
      this.emitChange({ kind: "removed", id, at: nowIso() });
      return;
    }
    const loop = await this.loadLoopDir(dir);
    if (!loop) return;
    const prev = this.cache.get(loop.id);
    this.cache.set(loop.id, loop);
    this.emitChange({ kind: prev ? "updated" : "added", id: loop.id, at: nowIso() });
  }

  private dirOf(filePath: string): string | null {
    const parts = filePath.split(/[\\/]/);
    if (parts.length < 2) return null;
    return join(this.loopsDir, parts[parts.length - 2] ?? "");
  }

  private async loadLoopDir(dir: string): Promise<Readonly<LoopPattern> | null> {
    let loopMd: string | null = null;
    try {
      loopMd = await readFile(join(dir, "LOOP.md"), "utf8");
    } catch {
      return null;
    }
    let gateYaml: string | null = null;
    let budgetYaml: string | null = null;
    try {
      gateYaml = await readFile(join(dir, "gate.yaml"), "utf8");
    } catch {
      /* optional */
    }
    try {
      budgetYaml = await readFile(join(dir, "budget.yaml"), "utf8");
    } catch {
      /* optional */
    }
    const parsed = parseOkfFile(loopMd, { filePath: join(dir, "LOOP.md") });
    const fm = parsed.frontmatter as Record<string, unknown>;
    const id = (fm.id as string) ?? `loop/${basename(dir)}`;
    if (id !== `loop/${basename(dir)}`) {
      throw new Error(`Loop id "${id}" does not match directory name "${basename(dir)}"`);
    }

    const config = parseJsonObject(fm.configJson ?? "{}", "configJson");
    if (parsed.body.trim()) config.instructions = parsed.body.trim();
    const gate = gatePolicySchema.parse(gateYaml ? yaml.load(gateYaml) : {});
    const budget = budgetSchema.parse(budgetYaml ? yaml.load(budgetYaml) : {});

    const loop: LoopPattern = loopPatternSchema.parse({
      id,
      type: "LoopPattern",
      title: fm.title,
      description: fm.description,
      timestamp: fm.timestamp,
      schedule: fm.schedule,
      agent: fm.agent,
      autonomyLevel: fm.autonomyLevel ?? "L1",
      status: fm.status ?? "enabled",
      pauseReason: fm.pauseReason,
      concurrencyPolicy: fm.concurrencyPolicy ?? "coalesce_if_active",
      catchUpPolicy: fm.catchUpPolicy ?? "skip_missed",
      configJson: JSON.stringify(config),
      gateJson: JSON.stringify(gate),
      budgetJson: JSON.stringify(budget),
    } as unknown as LoopPattern);

    return loop as Readonly<LoopPattern>;
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

function parseJsonObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "string") throw new Error(`${field} must be a JSON string`);
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${field} must contain a JSON object`);
  return parsed as Record<string, unknown>;
}
