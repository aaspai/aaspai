import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { DbHandle } from "@aaspai/db";
import { createDb, runMigrations } from "@aaspai/db";
import { LocalGitRepository } from "@aaspai/git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManualLocalExecutionService } from "../src/manual-run";
import { ExecutionStore } from "../src/store";

const execFileAsync = promisify(execFile);

describe("ManualLocalExecutionService", () => {
  let handle: DbHandle;
  let testDirectory: string;

  beforeEach(async () => {
    testDirectory = path.resolve("workspace", "m1", `manual-run-${randomUUID()}`);
    await mkdir(testDirectory, { recursive: true });
    process.env.AASPAI_DB = `sqlite:${path.join(testDirectory, "state.db")}`;
    handle = createDb();
    runMigrations(handle);
  });

  afterEach(async () => {
    await handle.close();
    delete process.env.AASPAI_DB;
    await rm(testDirectory, { recursive: true, force: true });
  });

  it("executes a real command in a real project worktree with pinned definitions", async () => {
    const blueprintPath = await createRepository("blueprint", "AGENT.md", "# CEO\n");
    const projectPath = await createRepository("project", "README.md", "project\n");
    const store = new ExecutionStore(handle.db);
    const service = new ManualLocalExecutionService(new LocalGitRepository(), store);
    const result = await service.run({
      organizationId: "org_test",
      goalTitle: "Ship a product",
      projectTitle: "Product",
      blueprintRepositoryPath: blueprintPath,
      projectRepositoryPath: projectPath,
      workspaceRoot: path.join(testDirectory, "workspace-root"),
      prompt: "Verify the isolated execution boundary",
      idempotencyKey: "manual:isolated-boundary",
      agentId: "agent_ceo",
      harness: "dry_run_local",
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify({ cwd: process.cwd(), definitions: process.env.AASPAI_DEFINITIONS_PATH }))",
      ],
    });

    const output = JSON.parse(result.result.stdout) as { cwd: string; definitions: string };
    expect(output.cwd).toContain(path.join("workspace-root", "execution"));
    expect(output.cwd).not.toBe(projectPath);
    expect(output.definitions).toContain(path.join("workspace-root", "definitions"));
    expect(result.attempt.status).toBe("succeeded");
    expect(await store.getWorkspace(result.workspaceId)).toMatchObject({ status: "released" });
    expect(await store.listEvents(result.attempt.id)).toHaveLength(2);
    await expect(readFile(path.join(projectPath, "README.md"), "utf8")).resolves.toBe("project\n");
  });

  async function createRepository(name: string, file: string, contents: string): Promise<string> {
    const repositoryPath = path.join(testDirectory, name);
    await mkdir(repositoryPath, { recursive: true });
    await git(repositoryPath, ["init"]);
    await git(repositoryPath, ["config", "user.email", "test@aaspai.local"]);
    await git(repositoryPath, ["config", "user.name", "Aaspai Test"]);
    await git(repositoryPath, ["branch", "-M", "main"]);
    await writeFile(path.join(repositoryPath, file), contents);
    await git(repositoryPath, ["add", "."]);
    await git(repositoryPath, ["commit", "-m", "test fixture"]);
    return repositoryPath;
  }

  async function git(cwd: string, args: string[]): Promise<void> {
    await execFileAsync("git", args, { cwd, windowsHide: true });
  }
});
