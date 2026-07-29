import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { LoopPattern } from "@aaspai/contracts/phase2";
import { createDb, runMigrations } from "@aaspai/db";
import { afterEach, describe, expect, it } from "vitest";
import { LoopControlStore, StateStore } from "../src/index";

describe("durable loop control and state", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => cleanup?.());

  it("persists pause independently for each organization and exposes it in state", async () => {
    const directory = path.resolve("workspace", "loops", `control-${randomUUID()}`);
    await mkdir(directory, { recursive: true });
    process.env.AASPAI_DB = `sqlite:${path.join(directory, "state.db")}`;
    const handle = createDb();
    runMigrations(handle);
    cleanup = async () => {
      await handle.close();
      await rm(directory, { recursive: true, force: true });
    };
    const controls = new LoopControlStore(handle.db);
    const state = new StateStore(handle.db);

    await controls.setPaused("org_a", PATTERN, true, "operator pause");
    await controls.setPaused("org_b", PATTERN, false);

    await expect(controls.isPaused("org_a", PATTERN.id)).resolves.toBe(true);
    await expect(controls.isPaused("org_b", PATTERN.id)).resolves.toBe(false);
    await expect(state.view(PATTERN.id, { organizationId: "org_a" })).resolves.toMatchObject({
      loopId: PATTERN.id,
      paused: true,
      workItems: [],
      attempts: [],
      humanOverrides: [],
    });
  });
});

const PATTERN: LoopPattern = {
  id: "loop/control-test",
  type: "LoopPattern",
  title: "Control test",
  description: "Control test",
  timestamp: "2026-07-29T00:00:00.000Z",
  schedule: { kind: "manual" },
  agent: "agent/test",
  autonomyLevel: "L1",
  status: "enabled",
  concurrencyPolicy: "coalesce_if_active",
  catchUpPolicy: "skip_missed",
  configJson: "{}",
  gateJson: "{}",
  budgetJson: "{}",
};
