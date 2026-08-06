import { type FSWatcher, watch } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { getLogger } from "@aaspai/observability";
import { nowIso, stableHash } from "./canonical.js";
import { ClaudeParser } from "./importers/claude.js";
import { CodexParser } from "./importers/codex.js";
import { GeminiParser } from "./importers/gemini.js";
import type { ImportSource, ImportState, SessionParser } from "./importers/types.js";
import { computeFileHash } from "./importers/types.js";
import type { LiveHub } from "./live.js";
import { publishLive } from "./publish.js";
import type { ImportStateRow, TelemetryRepository } from "./repository.js";

/**
 * Provider file watcher.
 *
 * Behavior adapted from the reference `backend/internal/watcher`
 * (watcher.go, scanner.go, tool_watcher.go):
 *
 * - watches only configured directories;
 * - scans existing files at startup (optional backfill);
 * - handles create/change events with per-file debounce;
 * - persists byte-offset progress so restart resumes without duplicating;
 * - polls for missed changes (fallback);
 * - a malformed file never stops other files;
 * - health exposes last scan, watched files, and last error.
 */

const log = getLogger("telemetry.watcher");

export interface WatcherConfig {
  organizationId: string;
  sources?: ImportSource[];
  debounceMs?: number;
  backfill?: boolean;
  pollIntervalMs?: number;
  envPaths?: { claude?: string; codex?: string; gemini?: string };
}

interface ToolWatcher {
  source: ImportSource;
  parser: SessionParser;
  watchDirs: string[];
  fileMatch: (filePath: string) => boolean;
  debounceMs: number;
}

export interface WatcherHealth {
  started: boolean;
  watchedFiles: number;
  lastScanAt: string | null;
  lastProcessedAt: string | null;
  lastError: string | null;
  processedCount: number;
  importErrors: number;
}

export class TelemetryWatcher {
  private readonly config: WatcherConfig;
  private readonly repo: TelemetryRepository;
  private readonly hub: LiveHub;
  private readonly toolWatchers: ToolWatcher[] = [];
  private readonly fsWatchers: FSWatcher[] = [];
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private pollTimer: NodeJS.Timeout | null = null;
  private started = false;
  private readonly watched = new Set<string>();
  private readonly missingDirs = new Map<string, string>();
  private health: WatcherHealth = {
    started: false,
    watchedFiles: 0,
    lastScanAt: null,
    lastProcessedAt: null,
    lastError: null,
    processedCount: 0,
    importErrors: 0,
  };
  private processing = new Set<string>();

  constructor(repo: TelemetryRepository, hub: LiveHub, config: WatcherConfig) {
    this.repo = repo;
    this.hub = hub;
    this.config = {
      sources: ["claude-code", "codex_cli_rs", "gemini_cli"],
      debounceMs: 200,
      backfill: false,
      pollIntervalMs: 30_000,
      ...config,
    };
    for (const source of this.config.sources ?? []) {
      const parser = this.parserFor(source);
      const paths = parserWatchPaths(source, this.config.envPaths ?? {});
      const debounce =
        source === "gemini_cli"
          ? Math.max(this.config.debounceMs ?? 200, 500)
          : (this.config.debounceMs ?? 200);
      this.toolWatchers.push({
        source,
        parser,
        watchDirs: paths,
        fileMatch: (p) =>
          source === "gemini_cli"
            ? basename(p).startsWith("session-") && p.endsWith(".json")
            : p.endsWith(".jsonl"),
        debounceMs: debounce,
      });
    }
  }

  private parserFor(source: ImportSource): SessionParser {
    const env = this.config.envPaths ?? {};
    switch (source) {
      case "claude-code":
        return new ClaudeParser(
          { organizationId: this.config.organizationId },
          { envPath: env.claude },
        );
      case "codex_cli_rs":
        return new CodexParser(
          { organizationId: this.config.organizationId },
          { envPath: env.codex },
        );
      case "gemini_cli":
        return new GeminiParser(
          { organizationId: this.config.organizationId },
          { envPath: env.gemini },
        );
      default:
        throw new Error(`unsupported watch source: ${source}`);
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.initialScan();
    for (const tw of this.toolWatchers) {
      for (const dir of tw.watchDirs) {
        this.attachFsWatch(dir, tw);
      }
    }
    this.pollTimer = setInterval(() => {
      void this.pollLoop().catch((err) => {
        this.health.lastError = String(err);
      });
    }, this.config.pollIntervalMs ?? 30_000);
    this.pollTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const w of this.fsWatchers) w.close();
    this.fsWatchers.length = 0;
  }

  healthSnapshot(): WatcherHealth {
    return { ...this.health, watchedFiles: this.watched.size };
  }

  private attachFsWatch(dir: string, tw: ToolWatcher): void {
    let watcher: FSWatcher;
    try {
      watcher = watch(dir, { persistent: false }, (_event, filename) => {
        if (!filename) return;
        const filePath = join(dir, filename);
        if (tw.fileMatch(filePath)) {
          this.scheduleProcess(tw, filePath);
        }
      });
    } catch (_err) {
      // Directory missing; record and rely on polling fallback.
      this.missingDirs.set(dir, tw.source);
      return;
    }
    this.fsWatchers.push(watcher);
    watcher.on("error", (err) => {
      this.health.lastError = String(err);
    });
  }

  private async initialScan(): Promise<void> {
    this.health.lastScanAt = nowIso();
    for (const tw of this.toolWatchers) {
      for (const dir of tw.watchDirs) {
        let size = 0;
        try {
          size = (await stat(dir)).size;
        } catch {
          this.missingDirs.set(dir, tw.source);
          continue;
        }
        void size;
        for (const filePath of await tw.parser.findSessionFiles()) {
          this.watched.add(filePath);
          const state = this.repo.getImportState(this.config.organizationId, tw.source, filePath);
          if (!state) {
            if (!this.config.backfill) {
              const fileSize = (await stat(filePath)).size;
              this.repo.setWatchFields(
                this.config.organizationId,
                tw.source,
                filePath,
                fileSize,
                0,
                "",
                "new",
              );
              continue;
            }
          } else if (state.byteOffset === 0 && state.fileHash !== "") {
            const fileSize = (await stat(filePath)).size;
            this.repo.setWatchFields(
              this.config.organizationId,
              tw.source,
              filePath,
              fileSize,
              state.messageCount,
            );
            continue;
          } else if (state.byteOffset > 0) {
            const fileSize = (await stat(filePath)).size;
            if (fileSize <= state.byteOffset) continue;
          }
          await this.processFile(tw, filePath, state ?? undefined);
        }
      }
    }
  }

  private scheduleProcess(tw: ToolWatcher, filePath: string): void {
    const existing = this.timers.get(filePath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(filePath);
      void this.processFile(tw, filePath).catch((err) => {
        this.health.lastError = String(err);
      });
    }, tw.debounceMs);
    this.timers.set(filePath, timer);
  }

  private async pollLoop(): Promise<void> {
    for (const tw of this.toolWatchers) {
      for (const dir of tw.watchDirs) {
        if (this.missingDirs.has(dir)) {
          try {
            await stat(dir);
            this.missingDirs.delete(dir);
            this.attachFsWatch(dir, tw);
          } catch {
            continue;
          }
        }
        for (const filePath of await tw.parser.findSessionFiles()) {
          this.watched.add(filePath);
          const state = this.repo.getImportState(this.config.organizationId, tw.source, filePath);
          if (!state) continue;
          let size = 0;
          try {
            size = (await stat(filePath)).size;
          } catch {
            continue;
          }
          if (size > state.byteOffset) {
            await this.processFile(tw, filePath, state);
          }
        }
      }
    }
  }

  private async processFile(
    tw: ToolWatcher,
    filePath: string,
    existingState?: ImportStateRow,
  ): Promise<void> {
    if (this.processing.has(filePath)) return;
    this.processing.add(filePath);
    try {
      const importState: ImportState =
        existingState && existingState.byteOffset > 0
          ? {
              byteOffset: existingState.byteOffset,
              messageCount: existingState.messageCount,
              parserState: existingState.parserState ?? {},
            }
          : { byteOffset: 0, messageCount: 0, parserState: {} };

      const incremental = await tw.parser.parseIncremental(filePath, importState);
      const fileHash = await computeFileHash(filePath).catch(() => "");
      const now = nowIso();
      const stateRow: ImportStateRow = {
        organizationId: this.config.organizationId,
        source: tw.source,
        filePath,
        fileHash:
          existingState?.fileHash && existingState.fileHash !== ""
            ? existingState.fileHash
            : fileHash,
        importedAt: existingState?.importedAt ?? now,
        recordCount: (existingState?.recordCount ?? 0) + incremental.recordCount,
        byteOffset: incremental.state.byteOffset,
        messageCount: incremental.state.messageCount,
        parserState: incremental.state.parserState,
        status: "current",
      };

      const result = this.repo.commitWatchBatch({
        logs: incremental.logs,
        spans: incremental.spans,
        metrics: incremental.metrics,
        state: stateRow,
      });

      this.health.lastProcessedAt = now;
      this.health.processedCount += 1;
      if (incremental.logs.length + incremental.metrics.length + incremental.spans.length > 0) {
        for (const log of incremental.logs) {
          publishLive(this.repo, this.hub, this.config.organizationId, "log", {
            id: log.id,
            observedAt: log.observedAt,
            provider: log.provider,
            body: log.body,
          });
        }
        publishLive(this.repo, this.hub, this.config.organizationId, "import", {
          source: tw.source,
          filePath,
          inserted: result.logs + result.metrics + result.spans,
          byteOffset: stateRow.byteOffset,
        });
      }
    } catch (err) {
      this.health.importErrors += 1;
      this.health.lastError = String(err);
      log.error("watcher process failed", { filePath, err: String(err) });
      const now = nowIso();
      this.repo.setImportState({
        organizationId: this.config.organizationId,
        source: tw.source,
        filePath,
        fileHash: existingState?.fileHash ?? "",
        importedAt: existingState?.importedAt ?? now,
        recordCount: existingState?.recordCount ?? 0,
        byteOffset: existingState?.byteOffset ?? 0,
        messageCount: existingState?.messageCount ?? 0,
        parserState: existingState?.parserState ?? null,
        status: "error",
        lastError: String(err).slice(0, 4_096),
      });
    } finally {
      this.processing.delete(filePath);
    }
  }
}

function parserWatchPaths(
  source: ImportSource,
  envPaths: { claude?: string; codex?: string; gemini?: string },
): string[] {
  switch (source) {
    case "claude-code":
      return claudePaths(envPaths.claude);
    case "codex_cli_rs":
      return envPaths.codex ? [envPaths.codex] : [];
    case "gemini_cli":
      return envPaths.gemini ? [envPaths.gemini] : [];
    default:
      return [];
  }
}

function claudePaths(envPath?: string): string[] {
  if (envPath) return [envPath];
  const home = homedir();
  return [join(home, ".config", "claude", "projects"), join(home, ".claude", "projects")];
}

export { stableHash };
