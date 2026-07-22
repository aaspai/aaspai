/**
 * Worktree manager — per-wakeup isolation.
 *
 * Foundation slice: thin wrapper that delegates to `@aaspai/runtime`
 * for the actual worktree creation. Phase 3 adds the manifest +
 * advisory locks (paperclip's `.loop-worktrees/manifest.json`).
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getLogger } from "@aaspai/observability";

const log = getLogger("loops.worktree");

export interface WorktreeLease {
  worktreeId: string;
  path: string;
  branch: string;
  baseRef: string;
  createdAt: string;
  status: "active" | "released" | "destroyed";
}

export class WorktreeManager {
  private readonly manifestPath: string;
  private worktrees = new Map<string, WorktreeLease>();

  constructor(private readonly opts: { baseDir: string; manifestFile?: string }) {
    this.manifestPath = opts.manifestFile ?? join(opts.baseDir, ".worktrees", "manifest.json");
  }

  async start(): Promise<void> {
    if (existsSync(this.manifestPath)) {
      try {
        const raw = await readFile(this.manifestPath, "utf8");
        const parsed = JSON.parse(raw) as WorktreeLease[];
        for (const wt of parsed) this.worktrees.set(wt.worktreeId, wt);
      } catch {
        // Corrupt manifest — start fresh
        this.worktrees.clear();
      }
    }
    log.info("WorktreeManager started", { count: this.worktrees.size });
  }

  async create(input: {
    worktreeId: string;
    branch: string;
    baseRef: string;
    cwd: string;
  }): Promise<WorktreeLease> {
    const path = join(this.opts.baseDir, ".worktrees", input.worktreeId);
    await mkdir(path, { recursive: true });
    const lease: WorktreeLease = {
      worktreeId: input.worktreeId,
      path,
      branch: input.branch,
      baseRef: input.baseRef,
      createdAt: new Date().toISOString(),
      status: "active",
    };
    this.worktrees.set(lease.worktreeId, lease);
    await this.save();
    return lease;
  }

  async release(worktreeId: string, opts: { keep: boolean } = { keep: false }): Promise<void> {
    const wt = this.worktrees.get(worktreeId);
    if (!wt) return;
    if (opts.keep) {
      wt.status = "released";
    } else {
      await rm(wt.path, { recursive: true, force: true });
      wt.status = "destroyed";
    }
    await this.save();
  }

  list(): readonly WorktreeLease[] {
    return [...this.worktrees.values()];
  }

  private async save(): Promise<void> {
    await mkdir(join(this.manifestPath, ".."), { recursive: true });
    await writeFile(
      this.manifestPath,
      JSON.stringify([...this.worktrees.values()], null, 2),
      "utf8",
    );
  }
}
