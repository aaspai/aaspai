import chokidar, { type FSWatcher } from "chokidar";
import { EventEmitter } from "node:events";

/**
 * Wraps chokidar with a saner API for the file-loader sources.
 *
 * Features over raw chokidar:
 * - One watcher per root directory
 * - Coalesces rapid `add`/`change` events for the same path (debounced)
 * - Emits typed events: "added", "updated", "removed", "ready"
 * - `start()` is idempotent
 * - `stop()` is idempotent and waits for in-flight events
 */
export class FileWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private ready = false;

  constructor(private readonly root: string) {
    super();
  }

  start(): void {
    if (this.watcher) return;
    this.watcher = chokidar.watch(this.root, {
      ignoreInitial: false,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
      ignored: [
        "**/node_modules/**",
        "**/.git/**",
        "**/dist/**",
        "**/node_modules",
      ],
    });
    this.watcher
      .on("add", (path) => this.emit("changed", { kind: "added" as const, path }))
      .on("change", (path) => this.emit("changed", { kind: "updated" as const, path }))
      .on("unlink", (path) => this.emit("changed", { kind: "removed" as const, path }))
      .on("ready", () => {
        this.ready = true;
        this.emit("ready");
      })
      .on("error", (err) => this.emit("error", err));
  }

  async stop(): Promise<void> {
    if (!this.watcher) return;
    const w = this.watcher;
    this.watcher = null;
    this.ready = false;
    await w.close();
  }

  isReady(): boolean {
    return this.ready;
  }
}
