import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type { AgentConfigSource, ChangeEvent, SourceDescriptor } from "@aaspai/contracts/phase2";
import { type AgentConfig, agentConfigSchema } from "@aaspai/contracts/phase2";
import type { JsonObject } from "@aaspai/contracts/primitives";
import { getLogger } from "@aaspai/observability";
import * as yaml from "js-yaml";
import { FileWatcher } from "./chokidar-watcher.js";
import { parseOkfFile, sha256HexSync } from "./okf-parser.js";

const log = getLogger("file-loader.agent-source");

/**
 * File-based `AgentConfigSource`.
 *
 * Reads `agents/<slug>/AGENT.md` (OKF frontmatter + body) plus the
 * optional sidecar files (`config.yaml`, `tools.yaml`,
 * `skills.lock.json`, `relations.yaml`) and exposes them through the
 * `AgentConfigSource` port.
 *
 * Watches the agents directory for changes via chokidar. Edits are
 * picked up in ~100ms; a periodic full rescan backs up the watch.
 */
export class FileAgentConfigSource implements AgentConfigSource {
  private readonly cache = new Map<string, Readonly<AgentConfig>>();
  private readonly byHash = new Map<string, Readonly<AgentConfig>>();
  private readonly watcher: FileWatcher;
  private readonly knownDirs = new Map<string, string>(); // dirPath -> agentId
  private rescanInterval: NodeJS.Timeout | null = null;
  private watching = false;
  private readonly callbacks = new Set<(change: ChangeEvent) => void>();

  constructor(private readonly agentsDir: string) {
    this.watcher = new FileWatcher(agentsDir);
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
    // Wait for the initial scan
    await new Promise<void>((resolve) => {
      if (this.watcher.isReady()) resolve();
      else this.watcher.once("ready", () => resolve());
    });
    // Do our own initial scan — the watcher only knows about file events,
    // not the agent-directory structure (subdirs + AGENT.md + sidecars).
    await this.scanAll();
    // Periodic safety rescan
    this.rescanInterval = setInterval(() => {
      this.scanAll().catch((err) => log.error("rescan failed", { err: String(err) }));
    }, 60_000);
    this.rescanInterval.unref();
    log.info("FileAgentConfigSource started", { dir: this.agentsDir, agents: this.cache.size });
  }

  async stop(): Promise<void> {
    this.watching = false;
    if (this.rescanInterval) {
      clearInterval(this.rescanInterval);
      this.rescanInterval = null;
    }
    await this.watcher.stop();
  }

  // ── The port ────────────────────────────────────────────────
  async get(id: string): Promise<Readonly<AgentConfig>> {
    const config = this.cache.get(id);
    if (!config) {
      throw new Error(`Unknown agent: ${id} (loaded: ${[...this.cache.keys()].join(", ")})`);
    }
    return config;
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
      label: `file:${this.agentsDir}`,
      detail: { agents: this.cache.size },
    };
  }

  // ── The internal loaders ────────────────────────────────────
  private async scanAll(): Promise<void> {
    const next = new Map<string, Readonly<AgentConfig>>();
    const nextDirs = new Map<string, string>();
    let entries: { name: string; isDirectory: () => boolean }[];
    try {
      entries = await readdir(this.agentsDir, { withFileTypes: true });
    } catch (err) {
      log.warn("agents dir not readable", { dir: this.agentsDir, err: String(err) });
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const dir = join(this.agentsDir, entry.name);
      try {
        const config = await this.loadAgentDir(dir);
        if (config) {
          next.set(config.id, config);
          nextDirs.set(dir, config.id);
        }
      } catch (err) {
        log.error("failed to load agent", { dir, err: String(err) });
      }
    }
    // Compute diff
    const added: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];
    for (const [id, c] of next) {
      const prev = this.cache.get(id);
      if (!prev) added.push(id);
      else if (prev !== c) updated.push(id);
    }
    for (const id of this.cache.keys()) {
      if (!next.has(id)) removed.push(id);
    }
    // Atomic swap
    this.cache.clear();
    this.byHash.clear();
    this.knownDirs.clear();
    for (const [k, v] of next) {
      this.cache.set(k, v);
      this.byHash.set(computeHash(v), v);
    }
    for (const [d, i] of nextDirs) this.knownDirs.set(d, i);
    // Emit
    for (const id of added) this.emitChange({ kind: "added", id, at: nowIso() });
    for (const id of updated) this.emitChange({ kind: "updated", id, at: nowIso() });
    for (const id of removed) this.emitChange({ kind: "removed", id, at: nowIso() });
  }

  private async handleChange(path: string, kind: "added" | "updated" | "removed"): Promise<void> {
    const dir = this.dirOf(path);
    if (!dir) return;
    if (kind === "removed") {
      const id = this.knownDirs.get(dir);
      if (!id) return;
      this.cache.delete(id);
      this.knownDirs.delete(dir);
      this.emitChange({ kind: "removed", id, at: nowIso() });
      return;
    }
    const config = await this.loadAgentDir(dir);
    if (!config) return;
    const prev = this.cache.get(config.id);
    this.cache.set(config.id, config);
    this.knownDirs.set(dir, config.id);
    this.byHash.set(computeHash(config), config);
    this.emitChange({ kind: prev ? "updated" : "added", id: config.id, at: nowIso() });
  }

  private dirOf(filePath: string): string | null {
    // Match the agent dir (the one that contains AGENT.md) or the sidecar files
    const rel = relative(this.agentsDir, filePath);
    if (rel.startsWith("..")) return null;
    const parts = rel.split(/[\\/]/);
    if (parts.length < 2) return null;
    return join(this.agentsDir, parts[0]!);
  }

  private async loadAgentDir(dir: string): Promise<Readonly<AgentConfig> | null> {
    let agentMd: string | null = null;
    let configYaml: string | null = null;
    let toolsYaml: string | null = null;
    let skillsLock: string | null = null;
    let relationsYaml: string | null = null;
    try {
      agentMd = await readFile(join(dir, "AGENT.md"), "utf8");
    } catch {
      // No AGENT.md → skip this directory
      return null;
    }
    try {
      configYaml = await readFile(join(dir, "config.yaml"), "utf8");
    } catch {
      /* optional */
    }
    try {
      toolsYaml = await readFile(join(dir, "tools.yaml"), "utf8");
    } catch {
      /* optional */
    }
    try {
      skillsLock = await readFile(join(dir, "skills.lock.json"), "utf8");
    } catch {
      /* optional */
    }
    try {
      relationsYaml = await readFile(join(dir, "relations.yaml"), "utf8");
    } catch {
      /* optional */
    }

    const parsed = parseOkfFile(agentMd, { filePath: join(dir, "AGENT.md") });
    const fm = parsed.frontmatter as Record<string, unknown>;
    const id = (fm.id as string) ?? `agent/${basename(dir)}`;
    if (id !== `agent/${basename(dir)}`) {
      throw new Error(
        `Agent id "${id}" does not match directory name "${basename(dir)}" (expected "agent/${basename(dir)}")`,
      );
    }

    const adapterConfig = configYaml ? (yaml.load(configYaml) as JsonObject) : ({} as JsonObject);
    const runtimeConfig = (fm.runtime as JsonObject) ?? ({} as JsonObject);
    const tools = toolsYaml ? (yaml.load(toolsYaml) as JsonObject) : ({} as JsonObject);
    const skills = skillsLock ? JSON.parse(skillsLock) : [];
    const relations = relationsYaml ? (yaml.load(relationsYaml) as JsonObject) : ({} as JsonObject);

    const config: AgentConfig = {
      id,
      type: "Agent",
      title: fm.title as string,
      description: fm.description as string,
      timestamp: fm.timestamp as string,
      adapter: (fm.adapter as string) ?? "claude_local",
      model: fm.model as string | undefined,
      role: (fm.role as AgentConfig["role"]) ?? "general",
      reportsTo: (fm.reportsTo as string | null) ?? null,
      manages: (fm.manages as string[]) ?? [],
      peers: (fm.peers as string[]) ?? [],
      systemPrompt: parsed.body,
      adapterConfig,
      runtimeConfig,
      runtime: runtimeConfig,
      tools,
      skills,
      knowledge: (fm.knowledge as JsonObject) ?? ({} as JsonObject),
      budget: (fm.budget as JsonObject) ?? ({} as JsonObject),
      relations,
    };

    return agentConfigSchema.parse(config) as Readonly<AgentConfig>;
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

function computeHash(config: Readonly<AgentConfig>): string {
  return sha256HexSync(JSON.stringify(config));
}
