import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeDefaultDb,
  companyProfiles,
  createDb,
  milestones,
  projectAssignments,
  projectObjectives,
  runMigrations,
} from "../src/index.js";

const handles: Array<{ close: () => Promise<void> }> = [];
const roots: string[] = [];
const previousDb = process.env.AASPAI_DB;

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  await closeDefaultDb();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  if (previousDb === undefined) delete process.env.AASPAI_DB;
  else process.env.AASPAI_DB = previousDb;
});

describe("strategic schema", () => {
  it("creates strategic tables and preserves the one-primary/one-manager invariants", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaspai-strategic-"));
    roots.push(root);
    process.env.AASPAI_DB = `sqlite:${join(root, "state.db")}`;
    const handle = createDb();
    handles.push(handle);
    runMigrations(handle);

    await handle.db.insert(companyProfiles).values({
      organizationId: "org_test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const profile = await handle.db
      .select()
      .from(companyProfiles)
      .where(eq(companyProfiles.organizationId, "org_test"));
    expect(profile[0]).toMatchObject({ lifecycleStatus: "draft", timezone: "UTC" });

    const now = new Date().toISOString();
    (handle.raw as { prepare: (sql: string) => { run: (...params: string[]) => void } })
      .prepare(
        "INSERT INTO goals (id, organization_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("goal_test", "org_test", "Objective", now, now);
    (handle.raw as { prepare: (sql: string) => { run: (...params: string[]) => void } })
      .prepare(
        "INSERT INTO projects (id, organization_id, goal_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("project_test", "org_test", "goal_test", "Project", now, now);

    await handle.db.insert(projectObjectives).values([
      {
        id: "po_false_1",
        organizationId: "org_test",
        projectId: "project_test",
        goalId: "goal_test",
        isPrimary: false,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "po_false_2",
        organizationId: "org_test",
        projectId: "project_test",
        goalId: "goal_test",
        isPrimary: false,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "po_primary",
        organizationId: "org_test",
        projectId: "project_test",
        goalId: "goal_test",
        isPrimary: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await expect(
      handle.db.insert(projectObjectives).values({
        id: "po_primary_2",
        organizationId: "org_test",
        projectId: "project_test",
        goalId: "goal_test",
        isPrimary: true,
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toThrow();

    await handle.db.insert(projectAssignments).values({
      id: "assignment_1",
      organizationId: "org_test",
      projectId: "project_test",
      agentId: "agent_manager",
      role: "manager",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await expect(
      handle.db.insert(projectAssignments).values({
        id: "assignment_2",
        organizationId: "org_test",
        projectId: "project_test",
        agentId: "agent_other",
        role: "manager",
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toThrow();
  });

  it("keeps milestone order unique within a project", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaspai-milestone-"));
    roots.push(root);
    process.env.AASPAI_DB = `sqlite:${join(root, "state.db")}`;
    const handle = createDb();
    handles.push(handle);
    runMigrations(handle);
    const now = new Date().toISOString();
    await expect(
      handle.db.insert(milestones).values([
        {
          id: "milestone_1",
          organizationId: "org_test",
          projectId: "project_test",
          title: "First",
          sequence: 1,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "milestone_2",
          organizationId: "org_test",
          projectId: "project_test",
          title: "Duplicate",
          sequence: 1,
          createdAt: now,
          updatedAt: now,
        },
      ]),
    ).rejects.toThrow();
  });

  it("backfills the primary objective link for an existing project", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaspai-backfill-"));
    roots.push(root);
    const path = join(root, "state.db");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE goals (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'planned',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        goal_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const now = new Date().toISOString();
    legacy
      .prepare(
        "INSERT INTO goals (id, organization_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("legacy_goal", "legacy_org", "Legacy objective", now, now);
    legacy
      .prepare(
        "INSERT INTO projects (id, organization_id, goal_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("legacy_project", "legacy_org", "legacy_goal", "Legacy project", now, now);
    legacy.close();

    process.env.AASPAI_DB = `sqlite:${path}`;
    const handle = createDb();
    handles.push(handle);
    runMigrations(handle);
    const links = await handle.db
      .select()
      .from(projectObjectives)
      .where(eq(projectObjectives.projectId, "legacy_project"));
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      organizationId: "legacy_org",
      goalId: "legacy_goal",
      isPrimary: true,
    });
  });
});
