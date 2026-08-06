import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DbHandle } from "@aaspai/db";
import { createDb, runMigrations } from "@aaspai/db";
import { defaultLiveHub } from "./live.js";
import { TelemetryRepository } from "./repository.js";

export interface TelemetryTestContext {
  handle: DbHandle;
  repo: TelemetryRepository;
  dbPath: string;
  cleanup(): Promise<void>;
  hub: typeof defaultLiveHub;
}

/** Create an isolated SQLite database with telemetry migrations applied. */
export async function createTelemetryTestContext(): Promise<TelemetryTestContext> {
  const dir = mkdtempSync(join(tmpdir(), "aaspai-telemetry-"));
  const dbPath = join(dir, "state.db");
  process.env.AASPAI_DB = `sqlite:${dbPath}`;
  const handle = createDb();
  runMigrations(handle);
  const repo = new TelemetryRepository(handle);
  return {
    handle,
    repo,
    dbPath,
    hub: defaultLiveHub,
    async cleanup() {
      await handle.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const TEST_ORGANIZATION = "org_test";
export const TEST_SESSION = "sess_test123";
