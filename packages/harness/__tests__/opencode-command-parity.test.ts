import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addOpencodeMcp,
  addOpencodeProvider,
  authOpencodeMcp,
  createOpencodeAgent,
  debugOpencodeConfig,
  debugOpencodeInfo,
  debugOpencodePaths,
  debugOpencodeSkills,
  deleteOpencodeSession,
  diffOpencodeSnapshot,
  exportOpencodeSessionSanitized,
  getAuthFilePath,
  getOpencodeConfigDir,
  listOpencodeAgents,
  listOpencodeAuth,
  listOpencodeMcp,
  listOpencodeModels,
  listOpencodeSessionsWithLimit,
  logoutOpencodeMcp,
  opencodeCli,
  opencodeCompletion,
  opencodeDbPath,
  opencodeProviders,
  opencodeSessionExport,
  opencodeSessionImport,
  opencodeSessionList,
  opencodeStats,
  queryOpencodeDb,
  refreshOpencodeModels,
  removeOpencodeAuth,
  runOpencodeHelloProbe,
  setOpencodeAuth,
  startOpencodeAcp,
  startOpencodeServe,
  stopOpencodeAcp,
  stopOpencodeServe,
  trackOpencodeSnapshot,
  upgradeOpencode,
  writeOpencodeAgentFile,
  writeOpencodeMcpServers,
  writeOpencodeSkill,
} from "../src/drivers/opencode-cli/implementation.js";
import {
  buildAdapterContext,
  FAKE_OPENCODE_CJS,
  fakeOpencodeCli,
  fakeOpencodeCommand,
  makeLockPath,
} from "./e2e/helpers.js";

const oldEnv = {
  auth: process.env.AASPAI_OPENCODE_AUTH_PATH,
  cli: process.env.OPENCODE_CLI,
  cliDir: process.env.OPENCODE_CLI_DIR,
  prompt: process.env.AASPAI_FAKE_OPENCODE_PROMPT_OVERRIDE,
  stderr: process.env.AASPAI_FAKE_OPENCODE_STDERR,
  nativeAuth: process.env.OPENCODE_AUTH_PATH,
};

afterEach(async () => {
  if (oldEnv.auth === undefined) delete process.env.AASPAI_OPENCODE_AUTH_PATH;
  else process.env.AASPAI_OPENCODE_AUTH_PATH = oldEnv.auth;
  if (oldEnv.cli === undefined) delete process.env.OPENCODE_CLI;
  else process.env.OPENCODE_CLI = oldEnv.cli;
  if (oldEnv.prompt === undefined) delete process.env.AASPAI_FAKE_OPENCODE_PROMPT_OVERRIDE;
  else process.env.AASPAI_FAKE_OPENCODE_PROMPT_OVERRIDE = oldEnv.prompt;
  if (oldEnv.stderr === undefined) delete process.env.AASPAI_FAKE_OPENCODE_STDERR;
  else process.env.AASPAI_FAKE_OPENCODE_STDERR = oldEnv.stderr;
  if (oldEnv.nativeAuth === undefined) delete process.env.OPENCODE_AUTH_PATH;
  else process.env.OPENCODE_AUTH_PATH = oldEnv.nativeAuth;
  if (oldEnv.cliDir === undefined) delete process.env.OPENCODE_CLI_DIR;
  else process.env.OPENCODE_CLI_DIR = oldEnv.cliDir;
});

describe("opencode command parity helpers", () => {
  it("runs providers, session portability, stats, and hello probes", async () => {
    process.env.AASPAI_FAKE_OPENCODE_STDERR = "diagnostic";
    expect(await opencodeProviders({ cli: fakeOpencodeCli() })).toEqual(["anthropic", "openai"]);
    expect(await opencodeSessionList({ cli: fakeOpencodeCli() })).toEqual([
      { id: "ses-one", title: "One", startedAt: "2026-01-01T00:00:00.000Z" },
      { id: "not-json" },
    ]);
    expect(await opencodeSessionExport("ses-one", { cli: fakeOpencodeCli() })).toContain(
      "exported",
    );
    expect(await opencodeSessionImport('{"session":"one"}', { cli: fakeOpencodeCli() })).toBe(
      "ses-imported",
    );
    expect(await opencodeStats("ses-one", { cli: fakeOpencodeCli() })).toMatchObject({
      sessionId: "ses-one",
      inputTokens: 3,
      outputTokens: 2,
      costUsd: 0.4,
    });
    process.env.AASPAI_FAKE_OPENCODE_PROMPT_OVERRIDE = "<e2e:hello:HELLO_PROBE_OK>";
    await expect(
      runOpencodeHelloProbe({
        cli: fakeOpencodeCommand(),
        commandArgs: [FAKE_OPENCODE_CJS],
        expectedReply: "HELLO_PROBE_OK",
      }),
    ).resolves.toMatchObject({ ok: true, reply: "HELLO_PROBE_OK" });
    delete process.env.AASPAI_FAKE_OPENCODE_PROMPT_OVERRIDE;
    delete process.env.AASPAI_FAKE_OPENCODE_STDERR;
  });

  it("returns safe failures for command helpers and probes", async () => {
    expect(await opencodeProviders({ cli: "missing-opencode" })).toEqual([]);
    expect(await opencodeSessionList({ cli: "missing-opencode" })).toEqual([]);
    expect(await opencodeStats("missing", { cli: "missing-opencode" })).toBeNull();
    await expect(opencodeSessionExport("missing", { cli: "missing-opencode" })).rejects.toThrow();
    await expect(opencodeSessionImport("{}", { cli: "missing-opencode" })).rejects.toThrow();
    await expect(
      runOpencodeHelloProbe({ cli: "missing-opencode", timeoutMs: 100 }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      runOpencodeHelloProbe({
        cli: fakeOpencodeCommand(),
        commandArgs: [FAKE_OPENCODE_CJS],
        expectedReply: "<e2e:hang>",
        timeoutMs: 20,
      }),
    ).resolves.toMatchObject({ ok: false, error: "hello probe timeout" });
    await expect(
      runOpencodeHelloProbe({
        cli: fakeOpencodeCommand(),
        commandArgs: [FAKE_OPENCODE_CJS],
        expectedReply: "EXPECTED_NOT_RETURNED",
      }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining("expected") });
    expect(await listOpencodeModels({ cli: "missing-opencode" })).toEqual([]);
  });

  it("starts and stops a persistent server and manages auth files", async () => {
    const serverKey = `server-${Date.now()}`;
    process.env.OPENCODE_CLI = FAKE_OPENCODE_CJS;
    const server = await startOpencodeServe({
      workspaceKey: serverKey,
      cwd: process.cwd(),
      env: { TEST_SERVER: "1" },
    });
    expect(server).toMatchObject({ url: "http://127.0.0.1:4321", port: 4321 });
    expect(await startOpencodeServe({ workspaceKey: serverKey, cwd: process.cwd() })).toEqual(
      server,
    );
    stopOpencodeServe(serverKey);
    stopOpencodeServe("missing-server");

    const dir = await mkdtemp(join(tmpdir(), "aaspai-opencode-auth-"));
    process.env.AASPAI_OPENCODE_AUTH_PATH = join(dir, "auth.json");
    expect(getAuthFilePath()).toContain("auth.json");
    expect(listOpencodeAuth()).toEqual({});
    expect(setOpencodeAuth("openai", "secret", { type: "oauth" })).toMatchObject({
      path: expect.stringContaining("auth.json"),
    });
    expect(listOpencodeAuth()).toEqual({ openai: { type: "oauth", hasKey: true } });
    expect(removeOpencodeAuth("missing").removed).toBe(false);
    expect(removeOpencodeAuth("openai").removed).toBe(true);
    expect(JSON.parse(await readFile(getAuthFilePath(), "utf8"))).toEqual({});
    await writeFile(getAuthFilePath(), JSON.stringify({ missingType: { key: "secret" } }), "utf8");
    expect(listOpencodeAuth()).toEqual({ missingType: { type: "api", hasKey: true } });
    await writeFile(getAuthFilePath(), "[]", "utf8");
    expect(listOpencodeAuth()).toEqual({});
    expect(getOpencodeConfigDir()).toBeTruthy();
    await rm(dir, { recursive: true, force: true });
  });

  it("covers model discovery, ACP process handles, and config file helpers", async () => {
    process.env.AASPAI_FAKE_OPENCODE_PROMPT_OVERRIDE = "<e2e:models_dump>";
    expect(
      await listOpencodeModels({ cli: fakeOpencodeCommand(), commandArgs: [FAKE_OPENCODE_CJS] }),
    ).toEqual(["provider/model-a", "provider/model-b"]);

    const key = `acp-${Date.now()}`;
    const acp = await startOpencodeAcp({
      cli: FAKE_OPENCODE_CJS,
      workspaceKey: key,
      port: 4322,
      hostname: "localhost",
      mdns: true,
      mdnsDomain: "local.test",
      cors: ["https://one.test", "https://two.test"],
    });
    expect(acp).toMatchObject({
      pid: expect.any(Number),
      port: 4322,
      hostname: "localhost",
      url: "http://localhost:4322",
    });
    acp.stop();
    await expect(acp.stopped).resolves.toMatchObject({ exitCode: null });
    expect(stopOpencodeAcp(key)).toBe(true);
    expect(stopOpencodeAcp()).toBe(false);

    await startOpencodeAcp({ cli: FAKE_OPENCODE_CJS, workspaceKey: `${key}-one`, port: 4323 });
    await startOpencodeAcp({ cli: FAKE_OPENCODE_CJS, workspaceKey: `${key}-two`, port: 4324 });
    expect(stopOpencodeAcp()).toBe(true);

    const dir = await mkdtemp(join(tmpdir(), "aaspai-opencode-files-"));
    try {
      expect(
        writeOpencodeMcpServers(
          { local: { type: "stdio", command: "node", args: ["x"], env: { A: "1" } } },
          { dir },
        ).path,
      ).toContain("mcp.json");
      expect(
        writeOpencodeMcpServers({ remote: { type: "http", url: "https://mcp.test" } }, { dir })
          .path,
      ).toContain("mcp.json");
      expect(
        writeOpencodeAgentFile("team\\lead", "body", { dir, frontmatter: { model: "test" } }).path,
      ).toContain("team_lead.md");
      const skill = writeOpencodeSkill("skill", "skill body", {
        dir,
        frontmatter: { mode: "test" },
        files: { "scripts/run.sh": "echo ok" },
      });
      expect(skill.path).toContain("SKILL.md");
      expect(
        addOpencodeProvider(
          "custom",
          { baseUrl: "https://provider.test", apiKey: "key", models: [{ id: "model" }] },
          { dir, auth: { type: "api" } },
        ).doc,
      ).toMatchObject({
        provider: { custom: { baseUrl: "https://provider.test" } },
        auth: { type: "api" },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("routes managed-runtime tools and parses error, usage, and company-action events", async () => {
    const logs: string[] = [];
    const events = [
      {
        type: "thinking",
        sessionID: "runtime-session",
        part: { type: "thinking", text: "thought" },
      },
      {
        type: "text",
        sessionID: "runtime-session",
        part: { type: "text", text: "runtime answer" },
      },
      {
        type: "tool_use",
        sessionID: "runtime-session",
        part: {
          type: "tool",
          tool: "read",
          callID: "read-1",
          input: { path: "x" },
          state: { status: "completed" },
        },
      },
      {
        type: "tool_use",
        sessionID: "runtime-session",
        part: {
          type: "tool",
          tool: "read",
          callID: "read-1",
          input: { path: "x" },
          state: { status: "completed" },
        },
      },
      {
        type: "tool_use",
        sessionID: "runtime-session",
        part: {
          type: "tool",
          tool: "company_action",
          callID: "company-1",
          input: { payload: JSON.stringify({ actions: [{ type: "hire" }] }) },
          state: { status: "completed" },
        },
      },
      {
        type: "tool_use",
        sessionID: "runtime-session",
        part: {
          type: "tool",
          tool: "company_action",
          callID: "company-2",
          input: { payload: "{" },
          state: { status: "completed" },
        },
      },
      { type: "error", error: { data: { message: "nested error" } } },
      {
        type: "step_finish",
        part: { type: "step-finish", tokens: { input: 7, output: 3 }, cost: 0.2 },
      },
    ];
    const stream = `${events.map((event) => JSON.stringify(event)).join("\n")}\nnot-json`;
    const run = async (options: {
      onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void> | void;
    }) => {
      await options.onLog?.("stdout", stream);
      await options.onLog?.("stderr", "runtime warning\n");
      return {
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        startedAt: "",
        finishedAt: "",
        durationMs: 1,
      };
    };
    const result = await opencodeCli.execute({
      protocolVersion: 1,
      runId: "run_runtime_tools",
      organizationId: "org_runtime_tools",
      agent: {
        id: "agent/runtime",
        organizationId: "org_runtime_tools",
        name: "Runtime",
        adapterType: "opencode_cli",
        adapterConfig: {},
      },
      runtime: {},
      config: { command: "runtime-opencode", model: "test" },
      context: { cwd: process.cwd(), prompt: "runtime" },
      execution: { run },
      tools: {
        invoke: async (name: string) => {
          if (name === "read") return { content: "file" };
          throw new Error("tool failed");
        },
      },
      onLog: async (_stream: "stdout" | "stderr", chunk: string) => logs.push(chunk),
    } as never);
    expect(result).toMatchObject({
      exitCode: 1,
      summary: "runtime answer",
      errorMessage: expect.stringContaining("Expected"),
    });
    expect((result.resultJson as { toolsInvoked: string[] }).toolsInvoked).toEqual([
      "read",
      "company_action",
      "company_action",
    ]);
    expect(logs.some((line) => line.includes('"kind":"tool_result"'))).toBe(true);
  });

  it("covers runtime parser fallbacks and every company-action/error shape", async () => {
    const events = [
      { type: "thinking", sessionID: "edge-session", part: { type: "thinking", text: "think" } },
      { type: "thinking", part: {} },
      { type: "text", sessionID: "edge-session", part: { type: "text", text: "answer" } },
      { type: "text", part: { type: "text" } },
      { type: "text", part: {} },
      {
        type: "tool",
        part: {
          tool: "input-tool",
          callID: "input",
          input: { value: 1 },
          state: { status: "started" },
        },
      },
      {
        type: "tool",
        part: {
          name: "args-tool",
          callID: "args",
          args: { value: 2 },
          state: { status: "failed" },
        },
      },
      {
        type: "tool_use",
        part: {
          name: "state-tool",
          callID: "state",
          state: { input: { value: 3 }, status: "cancelled" },
        },
      },
      { type: "tool_use", part: { name: "fallback-tool", state: { input: { value: 4 } } } },
      { type: "tool_use", part: { state: { input: { value: 5 } } } },
      {
        type: "tool_use",
        part: { tool: "company_action", callID: "empty", state: { status: "completed" } },
      },
      {
        type: "tool_use",
        part: { tool: "company_action", input: { payload: "{}" }, state: { status: "completed" } },
      },
      {
        type: "tool_use",
        part: {
          tool: "company_action",
          callID: "bad-object",
          input: null,
          state: { status: "completed" },
        },
      },
      {
        type: "tool_use",
        part: {
          tool: "company_action",
          callID: "bad-payload",
          input: { payload: 1 },
          state: { status: "completed" },
        },
      },
      {
        type: "tool_use",
        part: {
          tool: "string-tool",
          callID: "string-tool",
          state: { status: "completed", output: 1 },
        },
      },
      {
        type: "tool_use",
        part: { tool: "cancelled-tool", callID: "cancelled-tool", state: { status: "cancelled" } },
      },
      { type: "error", error: "plain error" },
      { type: "error", message: "top-level error" },
      { type: "error", error: { data: { message: "nested error" } } },
      { type: "error", error: { name: "named error" } },
      { type: "error", error: { code: "coded error" } },
      { type: "error", error: {} },
      { type: "error", error: 42 },
      { type: "error", error: null },
      { type: "error", error: { data: {} } },
      { type: "other" },
      { type: "step_finish", part: { tokens: {}, cost: 0 } },
    ];
    const logs: string[] = [];
    const result = await opencodeCli.execute({
      ...buildAdapterContext({
        prompt: "runtime edges",
        cwd: process.cwd(),
        runId: "run_runtime_edges",
      }),
      config: { command: "runtime-opencode", model: "test" },
      execution: {
        run: async (options: {
          onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void> | void;
        }) => {
          await options.onLog?.(
            "stdout",
            `\n${events.map((event) => JSON.stringify(event)).join("\n")}\npartial`,
          );
          await options.onLog?.("stderr", "   \n");
          await options.onLog?.("stderr", "runtime warning\n");
          return {
            exitCode: 0,
            timedOut: false,
            stdout: "",
            stderr: "",
            startedAt: "",
            finishedAt: "",
            durationMs: 1,
          };
        },
      },
      tools: {
        invoke: async (name: string) => {
          if (name === "args-tool") throw new Error("tool failed");
          if (name === "string-tool") throw "string tool failed";
          return name === "input-tool" ? "tool output" : { ok: true };
        },
      },
      onLog: async (_stream: "stdout" | "stderr", chunk: string) => logs.push(chunk),
    } as never);
    expect(result).toMatchObject({
      exitCode: 1,
      sessionId: "edge-session",
      errorMessage: expect.any(String),
    });
    expect(logs.some((line) => line.includes("partial"))).toBe(true);
  });

  it("covers the subcommand wrappers and their JSON/table fallbacks", async () => {
    const cli = FAKE_OPENCODE_CJS;
    const opts = { cli };
    expect((await deleteOpencodeSession("session", opts)).exitCode).toBe(0);
    expect(
      (await listOpencodeSessionsWithLimit({ ...opts, maxCount: 3, format: "table" })).rows.length,
    ).toBeGreaterThan(0);
    expect(
      (await listOpencodeSessionsWithLimit({ ...opts, format: "json" })).rows.length,
    ).toBeGreaterThan(0);
    expect(
      (await addOpencodeMcp("local", { type: "stdio", command: "node", args: ["x"] }, opts))
        .exitCode,
    ).toBe(0);
    expect(
      (await addOpencodeMcp("remote", { type: "http", url: "https://mcp.test" }, opts)).exitCode,
    ).toBe(0);
    expect((await listOpencodeMcp({ ...opts, format: "json" })).rows.length).toBeGreaterThan(0);
    expect((await listOpencodeMcp(opts)).rows.length).toBeGreaterThan(0);
    expect((await authOpencodeMcp("remote", opts)).exitCode).toBe(0);
    expect((await logoutOpencodeMcp("remote", opts)).exitCode).toBe(0);
    expect((await listOpencodeAgents(opts)).rows.length).toBeGreaterThan(0);
    expect((await createOpencodeAgent(opts)).exitCode).toBe(0);
    expect((await debugOpencodeConfig(opts)).raw).toBeTruthy();
    expect(await debugOpencodeSkills(opts)).toEqual([]);
    expect(await debugOpencodePaths(opts)).toEqual({});
    expect((await trackOpencodeSnapshot(opts)).raw).toBeTruthy();
    expect((await diffOpencodeSnapshot("abc123", opts)).patch).toBeTruthy();
    expect((await debugOpencodeInfo(opts)).raw).toBeTruthy();
    expect(
      (await queryOpencodeDb("select 1", { ...opts, format: "json" })).rows.length,
    ).toBeGreaterThan(0);
    expect((await opencodeDbPath(opts)).exitCode).toBe(0);
    expect((await refreshOpencodeModels({ ...opts, verbose: true })).raw).toBeTruthy();
    expect((await exportOpencodeSessionSanitized("session", opts)).json).toBeTruthy();
    expect((await upgradeOpencode({ ...opts, target: "latest", method: "npm" })).exitCode).toBe(0);
    expect((await opencodeCompletion("bash", opts)).exitCode).toBe(0);

    const controller = new AbortController();
    controller.abort();
    await expect(listOpencodeAgents({ ...opts, signal: controller.signal })).resolves.toMatchObject(
      { rows: expect.any(Array) },
    );

    const noisy = {
      cli,
      cwd: process.cwd(),
      env: { AASPAI_FAKE_OPENCODE_STDERR: "diagnostic stderr" },
    };
    await expect(listOpencodeAgents({ ...noisy, maxBuffer: 1 } as never)).resolves.toMatchObject({
      rows: expect.any(Array),
    });
    await expect(listOpencodeAgents({ cli: process.execPath })).resolves.toMatchObject({
      rows: expect.any(Array),
    });
    process.env.OPENCODE_CLI_DIR = process.cwd();
    await expect(listOpencodeAgents({ cli })).resolves.toMatchObject({ rows: expect.any(Array) });
    await expect(
      listOpencodeSessionsWithLimit({ cli, env: { AASPAI_FAKE_OPENCODE_SESSION_LIST_FAIL: "1" } }),
    ).resolves.toMatchObject({ rows: [] });
    await expect(
      listOpencodeSessionsWithLimit({
        cli,
        format: "json",
        env: { AASPAI_FAKE_OPENCODE_SESSION_LIST_MALFORMED: "1" },
      }),
    ).resolves.toMatchObject({ rows: ["{"] });
    await expect(
      listOpencodeMcp({
        cli,
        format: "json",
        env: { AASPAI_FAKE_OPENCODE_MCP_LIST_MALFORMED: "1" },
      }),
    ).resolves.toMatchObject({ rows: ["{"] });
    await expect(
      debugOpencodeConfig({ cli, env: { AASPAI_FAKE_OPENCODE_DEBUG_CONFIG_FAIL: "1" } }),
    ).resolves.toMatchObject({ doc: null, exitCode: 1 });
    await expect(
      debugOpencodeConfig({ cli, env: { AASPAI_FAKE_OPENCODE_DEBUG_CONFIG_MALFORMED: "1" } }),
    ).resolves.toMatchObject({ doc: null, exitCode: 0 });
    await expect(
      debugOpencodeSkills({ cli, env: { AASPAI_FAKE_OPENCODE_DEBUG_SKILL_FAIL: "1" } }),
    ).resolves.toEqual([]);
    await expect(
      debugOpencodeSkills({ cli, env: { AASPAI_FAKE_OPENCODE_DEBUG_SKILL_MALFORMED: "1" } }),
    ).resolves.toEqual([]);
    await expect(
      debugOpencodeSkills({ cli, env: { AASPAI_FAKE_OPENCODE_DEBUG_SKILL_OBJECT: "1" } }),
    ).resolves.toEqual([
      { name: "skill", description: undefined, location: "loc", content: undefined },
      { name: "", description: undefined, location: undefined, content: "body" },
    ]);
    await expect(
      debugOpencodePaths({ cli, env: { AASPAI_FAKE_OPENCODE_DEBUG_PATH_FAIL: "1" } }),
    ).resolves.toEqual({});
    const oldNoId = process.env.AASPAI_FAKE_OPENCODE_SESSION_LIST_NO_ID;
    const oldStatsPartial = process.env.AASPAI_FAKE_OPENCODE_STATS_PARTIAL;
    process.env.AASPAI_FAKE_OPENCODE_SESSION_LIST_NO_ID = "1";
    process.env.AASPAI_FAKE_OPENCODE_STATS_PARTIAL = "1";
    try {
      await expect(opencodeSessionList({ cli: fakeOpencodeCli() })).resolves.toEqual([
        { id: "", title: "No id" },
        { id: "not-json" },
      ]);
      await expect(opencodeStats("session", { cli: fakeOpencodeCli() })).resolves.toMatchObject({
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        costUsd: 0,
      });
    } finally {
      if (oldNoId === undefined) delete process.env.AASPAI_FAKE_OPENCODE_SESSION_LIST_NO_ID;
      else process.env.AASPAI_FAKE_OPENCODE_SESSION_LIST_NO_ID = oldNoId;
      if (oldStatsPartial === undefined) delete process.env.AASPAI_FAKE_OPENCODE_STATS_PARTIAL;
      else process.env.AASPAI_FAKE_OPENCODE_STATS_PARTIAL = oldStatsPartial;
    }
    await expect(addOpencodeMcp("stdio-empty", { type: "stdio" }, opts)).resolves.toMatchObject({
      exitCode: 0,
    });
    await expect(addOpencodeMcp("http-empty", { type: "http" }, opts)).resolves.toMatchObject({
      exitCode: 0,
    });
    await expect(upgradeOpencode({ cli })).resolves.toMatchObject({ exitCode: 0 });
    process.env.OPENCODE_CLI = cli;
    await expect(listOpencodeAgents()).resolves.toMatchObject({ rows: expect.any(Array) });
  });

  it("covers managed runtime stderr and company-action failure edges", async () => {
    process.env.AASPAI_OPENCODE_LOCK_PATH = makeLockPath("runtime-edge");
    const runtimeResult = await opencodeCli.execute({
      ...buildAdapterContext({
        prompt: "runtime stderr",
        cwd: process.cwd(),
        runId: "run_runtime_stderr",
      }),
      config: { command: "runtime-opencode", model: "test" },
      execution: {
        run: async () => {
          return {
            exitCode: 1,
            timedOut: false,
            stdout: "",
            stderr: "buffered stderr\n",
            startedAt: "",
            finishedAt: "",
            durationMs: 1,
          };
        },
      },
    } as never);
    expect(runtimeResult.errorMessage).toBe("buffered stderr");

    const streamedRuntime = await opencodeCli.execute({
      ...buildAdapterContext({
        prompt: "runtime streamed stderr",
        cwd: process.cwd(),
        runId: "run_runtime_streamed_stderr",
      }),
      config: { command: "runtime-opencode", model: "test" },
      execution: {
        run: async (options: {
          onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void> | void;
        }) => {
          await options.onLog?.("stderr", "streamed stderr\n");
          return {
            exitCode: 1,
            timedOut: false,
            stdout: "",
            stderr: "",
            startedAt: "",
            finishedAt: "",
            durationMs: 1,
          };
        },
      },
    } as never);
    expect(streamedRuntime.errorMessage).toBe("streamed stderr");

    const badCompany = await opencodeCli.execute({
      ...buildAdapterContext({
        prompt: "runtime bad company",
        cwd: process.cwd(),
        runId: "run_bad_company",
      }),
      config: { command: "runtime-opencode", model: "test" },
      execution: {
        run: async (options: {
          onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void> | void;
        }) => {
          await options.onLog?.(
            "stdout",
            `${JSON.stringify({
              type: "tool_use",
              part: {
                type: "tool",
                tool: "company_action",
                callID: "bad",
                input: "not-object",
                state: { status: "completed" },
              },
            })}\n`,
          );
          return {
            exitCode: 0,
            timedOut: false,
            stdout: "",
            stderr: "",
            startedAt: "",
            finishedAt: "",
            durationMs: 1,
          };
        },
      },
    } as never);
    expect(badCompany.exitCode).toBe(1);

    process.env.AASPAI_FAKE_OPENCODE_PROMPT_OVERRIDE = "<e2e:company-action-invalid>";
    await expect(
      opencodeCli.execute({
        ...buildAdapterContext({
          prompt: "company action",
          cwd: process.cwd(),
          runId: "run_company_invalid",
        }),
        config: { command: fakeOpencodeCommand(), commandArgs: [FAKE_OPENCODE_CJS] },
      } as never),
    ).resolves.toMatchObject({
      exitCode: 1,
      errorMessage: expect.stringContaining("Unexpected token"),
    });
    delete process.env.AASPAI_FAKE_OPENCODE_PROMPT_OVERRIDE;
  });

  it("covers config coercion, injection, environment verification, and result limits", async () => {
    process.env.AASPAI_OPENCODE_LOCK_PATH = makeLockPath("command-parity");
    let observed: { args?: string[]; env?: Record<string, string> } = {};
    const configured = await opencodeCli.execute({
      ...buildAdapterContext({ prompt: "configured", cwd: process.cwd(), runId: "run_configured" }),
      config: {
        command: fakeOpencodeCommand(),
        model: "test",
        title: "title",
        commandArgs: ["--wrapper", 2],
        port: "4321",
        replayLimit: "4",
        autoupdate: true,
        snapshot: false,
        mcpServers: {
          good: {
            type: "stdio",
            command: "node",
            args: ["a", 2],
            env: { A: "1", BAD: 2 },
            headers: { X: "yes", BAD: 2 },
          },
          bad: { type: "invalid" },
        },
        providers: { test: { apiKey: "key" } },
        permissions: { shell: "allow" },
        opencodeJson: { permission: { read: "deny" } },
        xdgConfigHome: await mkdtemp(join(tmpdir(), "aaspai-opencode-config-")),
        disableProjectConfig: true,
        allowAllModels: true,
        serverPassword: "pass",
        serverUsername: "user",
        opencodeConfig: "config.json",
        opencodeConfigContent: "{}",
        disableDefaultPlugins: true,
        pureEnv: true,
        disableExternalSkills: true,
        disableClaudeCodeSkills: true,
      },
      execution: {
        run: async (options: {
          args: string[];
          env: Record<string, string>;
          onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void> | void;
        }) => {
          observed = { args: options.args, env: options.env };
          const now = new Date().toISOString();
          return {
            exitCode: 0,
            timedOut: false,
            stdout: "",
            stderr: "",
            startedAt: now,
            finishedAt: now,
            durationMs: 1,
          };
        },
      },
    } as never);
    expect(configured.exitCode).toBe(0);
    expect(observed.args).toEqual(
      expect.arrayContaining(["--port", "4321", "--replay-limit", "4"]),
    );
    expect(observed.env).toMatchObject({
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_ALLOW_ALL_MODELS: "1",
      OPENCODE_SERVER_PASSWORD: "pass",
      OPENCODE_SERVER_USERNAME: "user",
      OPENCODE_CONFIG: "config.json",
      OPENCODE_CONFIG_CONTENT: "{}",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_PURE: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    });

    const fullConfig = await opencodeCli.execute({
      ...buildAdapterContext({
        prompt: "full config",
        cwd: process.cwd(),
        runId: "run_full_config",
        onMeta: async () => undefined,
      }),
      config: {
        command: "runtime-opencode",
        model: "model",
        title: "title",
        variant: "high",
        agent: "agent",
        thinking: true,
        continueLast: true,
        shareSession: true,
        shareMode: "auto",
        pure: true,
        autoApprove: true,
        logLevel: "debug",
        printLogs: true,
        workingDir: process.cwd(),
        attachments: ["a.txt"],
        attachServer: "http://server",
        serverPassword: "password",
        serverUsername: "username",
        port: "4321",
        opencodeJson: { existing: true },
        permissions: { read: "allow" },
        providers: { test: { apiKey: "key" } },
        compaction: { auto: true },
        primaryTools: ["read"],
        mcpTimeoutMs: 100,
        toolOutputMaxLines: 10,
        toolOutputMaxBytes: "1000",
        instructions: ["instruction"],
        smallModel: "small",
        defaultAgent: "default",
        shell: "bash",
        disabledProviders: ["disabled"],
        enabledProviders: ["enabled"],
        references: {
          docs: {
            path: "docs",
            repository: "repo",
            branch: "main",
            description: "docs",
            hidden: false,
          },
        },
        skillsPaths: ["skills"],
        skillsUrls: ["https://skills.test"],
        autoupdate: false,
        snapshot: true,
        commandArgs: ["--wrapper"],
      },
      execution: {
        run: async () => ({
          exitCode: 0,
          timedOut: false,
          stdout: "",
          stderr: "",
          startedAt: "",
          finishedAt: "",
          durationMs: 1,
        }),
      },
    } as never);
    expect(fullConfig.exitCode).toBe(0);
    await expect(
      opencodeCli.execute({
        ...buildAdapterContext({
          prompt: "tool bytes",
          cwd: process.cwd(),
          runId: "run_tool_bytes",
        }),
        config: {
          command: "runtime-opencode",
          mcpTimeoutMs: 10,
          toolOutputMaxBytes: 10,
          skillsUrls: ["https://skills.test"],
        },
        execution: {
          run: async () => ({
            exitCode: 0,
            timedOut: false,
            stdout: "",
            stderr: "",
            startedAt: "",
            finishedAt: "",
            durationMs: 1,
          }),
        },
      } as never),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      opencodeCli.execute({
        ...buildAdapterContext({
          prompt: "tool lines",
          cwd: process.cwd(),
          runId: "run_tool_lines",
        }),
        config: { command: "runtime-opencode", toolOutputMaxLines: 10 },
        execution: {
          run: async () => ({
            exitCode: 0,
            timedOut: false,
            stdout: "",
            stderr: "",
            startedAt: "",
            finishedAt: "",
            durationMs: 1,
          }),
        },
      } as never),
    ).resolves.toMatchObject({ exitCode: 0 });

    const authDir = await mkdtemp(join(tmpdir(), "aaspai-opencode-env-"));
    process.env.OPENCODE_AUTH_PATH = join(authDir, "auth.json");
    await writeFile(
      process.env.OPENCODE_AUTH_PATH,
      JSON.stringify({ provider: { type: "api" } }),
      "utf8",
    );
    process.env.AASPAI_FAKE_OPENCODE_PROMPT_OVERRIDE = "<e2e:hello:HELLO_PROBE_OK>";
    const environment = await opencodeCli.testEnvironment(
      buildAdapterContext({ prompt: "ignored", cwd: process.cwd(), runId: "run_env" }) as never,
    );
    expect(environment.ok).toBe(true);
    expect(environment.checks).toEqual(
      expect.arrayContaining([
        {
          name: "opencode_cli.auth",
          level: "info",
          message: "OpenCode native authentication is configured",
        },
      ]),
    );
    process.env.AASPAI_FAKE_OPENCODE_PROMPT_OVERRIDE = "wrong hello";
    await expect(
      opencodeCli.testEnvironment(
        buildAdapterContext({
          prompt: "ignored",
          cwd: process.cwd(),
          runId: "run_env_hello_failure",
        }) as never,
      ),
    ).resolves.toMatchObject({
      checks: expect.arrayContaining([
        expect.objectContaining({
          name: "opencode_cli.hello",
          level: "warn",
          message: expect.stringContaining("hello probe failed"),
        }),
      ]),
    });
    await writeFile(process.env.OPENCODE_AUTH_PATH, "{}", "utf8");
    await expect(
      opencodeCli.testEnvironment(
        buildAdapterContext({
          prompt: "ignored",
          cwd: process.cwd(),
          runId: "run_env_empty_auth",
        }) as never,
      ),
    ).resolves.toMatchObject({
      ok: false,
      checks: expect.arrayContaining([
        expect.objectContaining({
          name: "opencode_cli.auth",
          level: "error",
          message: expect.stringContaining("auth store is empty"),
        }),
      ]),
    });
    delete process.env.AASPAI_FAKE_OPENCODE_PROMPT_OVERRIDE;
    await expect(
      opencodeCli.testEnvironment({
        ...buildAdapterContext({ prompt: "ignored", cwd: process.cwd(), runId: "run_env_missing" }),
        config: { command: "missing-opencode", commandArgs: [] },
      } as never),
    ).resolves.toMatchObject({ ok: false, checks: [{ name: "opencode_cli", level: "error" }] });

    const previousModelsFail = process.env.AASPAI_FAKE_OPENCODE_MODELS_FAIL;
    process.env.OPENCODE_AUTH_PATH = join(authDir, "missing-auth.json");
    process.env.AASPAI_FAKE_OPENCODE_PROMPT_OVERRIDE = "<e2e:models_dump>";
    process.env.AASPAI_FAKE_OPENCODE_MODELS_FAIL = "1";
    try {
      await expect(
        opencodeCli.testEnvironment({
          config: { command: fakeOpencodeCommand(), commandArgs: [FAKE_OPENCODE_CJS] },
          cwd: process.cwd(),
        } as never),
      ).resolves.toMatchObject({
        ok: false,
        checks: expect.arrayContaining([
          expect.objectContaining({
            name: "opencode_cli.auth",
            level: "error",
            message: expect.stringContaining("not authenticated"),
          }),
          expect.objectContaining({ name: "opencode_cli.models", level: "warn" }),
        ]),
      });
    } finally {
      if (previousModelsFail === undefined) delete process.env.AASPAI_FAKE_OPENCODE_MODELS_FAIL;
      else process.env.AASPAI_FAKE_OPENCODE_MODELS_FAIL = previousModelsFail;
      delete process.env.AASPAI_FAKE_OPENCODE_PROMPT_OVERRIDE;
    }

    await expect(
      opencodeCli.execute(
        buildAdapterContext({
          prompt: "<e2e:success:long:1048600>",
          cwd: process.cwd(),
          runId: "run_too_long",
        }) as never,
      ),
    ).rejects.toThrow("1 MiB");

    const invalidHome = join(
      await mkdtemp(join(tmpdir(), "aaspai-opencode-invalid-home-")),
      "not-a-directory",
    );
    await writeFile(invalidHome, "file", "utf8");
    await expect(
      opencodeCli.execute({
        ...buildAdapterContext({
          prompt: "cleanup",
          cwd: process.cwd(),
          runId: "run_config_write_failure",
        }),
        config: {
          command: fakeOpencodeCommand(),
          commandArgs: [FAKE_OPENCODE_CJS],
          model: "test",
          xdgConfigHome: invalidHome,
          opencodeJson: { permission: { read: "deny" } },
          mcpServers: { local: { type: "stdio", command: "node" } },
        },
      } as never),
    ).resolves.toMatchObject({ exitCode: 0 });

    await expect(
      opencodeCli.execute({
        ...buildAdapterContext({
          prompt: "cleanup",
          cwd: process.cwd(),
          runId: "run_config_cleanup",
        }),
        config: {
          command: fakeOpencodeCommand(),
          commandArgs: [FAKE_OPENCODE_CJS],
          model: "test",
          opencodeJson: { permission: { read: "deny" } },
          mcpServers: { local: { type: "stdio", command: "node" } },
        },
      } as never),
    ).resolves.toMatchObject({ exitCode: 0 });
  });

  it("uses safe defaults for empty runtime results and false-valued config controls", async () => {
    const result = await opencodeCli.execute({
      ...buildAdapterContext({
        prompt: "fallback tokens",
        cwd: process.cwd(),
        runId: "run_empty_runtime",
      }),
      config: {
        command: "runtime-opencode",
        model: "test",
        autoupdate: false,
        snapshot: true,
        mcpServers: { missing: { command: "ignored" } },
      },
      execution: {
        run: async (options: {
          onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void> | void;
        }) => {
          await options.onLog?.(
            "stdout",
            `${JSON.stringify({ type: "text", part: { type: "text", text: "short" } })}\n`,
          );
          return {
            exitCode: 0,
            timedOut: false,
            stdout: "",
            stderr: "",
            startedAt: "",
            finishedAt: "",
            durationMs: 1,
          };
        },
      },
    } as never);
    expect(result.sessionId).toMatch(/^oc_/);
    expect(result.usage?.inputTokens).toBeGreaterThan(0);
    expect(result.usage?.outputTokens).toBeGreaterThan(0);

    await expect(
      opencodeCli.execute({
        ...buildAdapterContext({
          prompt: "ignored",
          cwd: process.cwd(),
          runId: "run_null_context",
        }),
        config: {
          command: "runtime-opencode",
          port: "bad",
          timeoutSec: "bad",
          graceSec: "bad",
          replayLimit: "bad",
          mcpTimeoutMs: "bad",
          toolOutputMaxLines: "bad",
          toolOutputMaxBytes: "bad",
        },
        context: { cwd: process.cwd() },
        execution: {
          run: async () => ({
            exitCode: 0,
            timedOut: false,
            stdout: "",
            stderr: "",
            startedAt: "",
            finishedAt: "",
            durationMs: 1,
          }),
        },
      } as never),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      opencodeCli.execute({
        ...buildAdapterContext({ prompt: "ignored", cwd: process.cwd(), runId: "run_null_config" }),
        config: null,
        context: { cwd: process.cwd() },
        execution: {
          run: async () => ({
            exitCode: 0,
            timedOut: false,
            stdout: "",
            stderr: "",
            startedAt: "",
            finishedAt: "",
            durationMs: 1,
          }),
        },
      } as never),
    ).resolves.toMatchObject({ exitCode: 0 });
  });

  it("covers local tail parsing and the hard timeout escalation", async () => {
    process.env.AASPAI_OPENCODE_LOCK_PATH = makeLockPath("local-tail");
    const tail = await opencodeCli.execute(
      buildAdapterContext({
        prompt: "<e2e:tail-only>",
        cwd: process.cwd(),
        runId: "run_tail_only",
      }) as never,
    );
    expect(tail).toMatchObject({ exitCode: 0, sessionId: "tail-session", summary: "tail" });

    process.env.AASPAI_OPENCODE_LOCK_PATH = makeLockPath("local-tail-malformed");
    const malformed = await opencodeCli.execute(
      buildAdapterContext({
        prompt: "<e2e:tail-malformed>",
        cwd: process.cwd(),
        runId: "run_tail_malformed",
      }) as never,
    );
    expect(malformed.exitCode).toBe(0);

    process.env.AASPAI_OPENCODE_LOCK_PATH = makeLockPath("local-tail-lines");
    await expect(
      opencodeCli.execute(
        buildAdapterContext({
          prompt: "<e2e:tail-lines>",
          cwd: process.cwd(),
          runId: "run_tail_lines",
        }) as never,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });

    process.env.AASPAI_OPENCODE_LOCK_PATH = makeLockPath("local-branches");
    await expect(
      opencodeCli.execute({
        ...buildAdapterContext({
          prompt: "<e2e:local-branches>",
          cwd: process.cwd(),
          runId: "run_local_branches",
        }),
        tools: { invoke: async () => ({ ok: true }) },
      } as never),
    ).resolves.toMatchObject({
      exitCode: 1,
      errorMessage: expect.stringContaining("second local error"),
    });

    await expect(
      opencodeCli.execute({
        ...buildAdapterContext({
          prompt: "missing prompt",
          cwd: process.cwd(),
          runId: "run_missing_prompt",
        }),
        context: { cwd: process.cwd() },
      } as never),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      opencodeCli.execute({
        ...buildAdapterContext({
          prompt: "null prompt",
          cwd: process.cwd(),
          runId: "run_null_prompt",
        }),
        context: { cwd: process.cwd(), prompt: null },
      } as never),
    ).resolves.toMatchObject({ exitCode: 0 });

    process.env.AASPAI_OPENCODE_LOCK_PATH = makeLockPath("local-timeout");
    const timedOut = await opencodeCli.execute(
      buildAdapterContext({
        prompt: "<e2e:hang> <e2e:ignore_term>",
        cwd: process.cwd(),
        runId: "run_local_timeout",
        adapterConfig: { timeoutSec: 1, graceSec: 1 },
      }) as never,
    );
    expect(timedOut).toMatchObject({ timedOut: true, errorCode: "timeout" });
  }, 10_000);

  it("covers serve startup timeout, hello malformed output, and ACP fallback defaults", async () => {
    process.env.OPENCODE_CLI = FAKE_OPENCODE_CJS;
    process.env.AASPAI_FAKE_OPENCODE_SERVE_HANG = "1";
    await expect(
      startOpencodeServe({ workspaceKey: `server-timeout-${Date.now()}` }),
    ).rejects.toThrow("startup timeout");
    delete process.env.AASPAI_FAKE_OPENCODE_SERVE_HANG;

    await expect(
      startOpencodeServe({
        cli: "missing-opencode-serve",
        workspaceKey: `server-error-${Date.now()}`,
      }),
    ).rejects.toThrow();
    process.env.OPENCODE_CLI = FAKE_OPENCODE_CJS;

    process.env.AASPAI_FAKE_OPENCODE_STDOUT = "not-json";
    await expect(
      runOpencodeHelloProbe({
        cli: fakeOpencodeCommand(),
        commandArgs: [FAKE_OPENCODE_CJS],
        expectedReply: "HELLO_PROBE_OK",
      }),
    ).resolves.toMatchObject({ ok: false });
    delete process.env.AASPAI_FAKE_OPENCODE_STDOUT;

    expect(stopOpencodeAcp("missing-acp")).toBe(false);
    process.env.OPENCODE_CLI_DIR = process.cwd();
    const defaultCwdAcp = await startOpencodeAcp({
      cli: FAKE_OPENCODE_CJS,
      workspaceKey: `acp-cwd-${Date.now()}`,
    });
    defaultCwdAcp.stop();
    await defaultCwdAcp.stopped;
    const envAcpKey = `acp-env-${Date.now()}`;
    const envAcp = await startOpencodeAcp({ workspaceKey: envAcpKey });
    envAcp.stop();
    await envAcp.stopped;
    await expect(
      opencodeCli.testEnvironment({
        config: { command: fakeOpencodeCommand(), commandArgs: [FAKE_OPENCODE_CJS] },
        cwd: process.cwd(),
      } as never),
    ).resolves.toBeTruthy();
  }, 12_000);

  it("stops a local run that is already aborted before spawn", async () => {
    const signal = new AbortController();
    signal.abort();
    process.env.AASPAI_OPENCODE_LOCK_PATH = makeLockPath("local-pre-abort");
    await expect(
      opencodeCli.execute(
        buildAdapterContext({
          prompt: "<e2e:success>",
          cwd: process.cwd(),
          runId: "run_pre_abort",
          signal: signal.signal,
        }) as never,
      ),
    ).resolves.toMatchObject({ exitCode: null });
  }, 5_000);

  it("covers cross-process lock timeout, stale ownership, and filesystem errors", async () => {
    const stalePath = makeLockPath("lock-stale-zero");
    process.env.AASPAI_OPENCODE_LOCK_PATH = stalePath;
    await writeFile(stalePath, "0@stale@owner", "utf8");
    await expect(
      opencodeCli.execute({
        ...buildAdapterContext({
          prompt: "lock stale",
          cwd: process.cwd(),
          runId: "run_lock_stale",
        }),
        config: { command: "runtime-opencode" },
        execution: {
          run: async () => ({
            exitCode: 0,
            timedOut: false,
            stdout: "",
            stderr: "",
            startedAt: "",
            finishedAt: "",
            durationMs: 1,
          }),
        },
      } as never),
    ).resolves.toMatchObject({ exitCode: 0 });

    const ownerRacePath = makeLockPath("lock-owner-race");
    process.env.AASPAI_OPENCODE_LOCK_PATH = ownerRacePath;
    await expect(
      opencodeCli.execute({
        ...buildAdapterContext({
          prompt: "lock owner race",
          cwd: process.cwd(),
          runId: "run_lock_owner_race",
        }),
        config: { command: "runtime-opencode" },
        execution: {
          run: async () => {
            await writeFile(ownerRacePath, "other@owner", "utf8");
            return {
              exitCode: 0,
              timedOut: false,
              stdout: "",
              stderr: "",
              startedAt: "",
              finishedAt: "",
              durationMs: 1,
            };
          },
        },
      } as never),
    ).resolves.toMatchObject({ exitCode: 0 });
    await rm(ownerRacePath, { force: true });

    delete process.env.AASPAI_OPENCODE_LOCK_PATH;
    await expect(
      opencodeCli.execute({
        ...buildAdapterContext({
          prompt: "lock default",
          cwd: process.cwd(),
          runId: "run_lock_default",
        }),
        config: { command: "runtime-opencode" },
        execution: {
          run: async () => ({
            exitCode: 0,
            timedOut: false,
            stdout: "",
            stderr: "",
            startedAt: "",
            finishedAt: "",
            durationMs: 1,
          }),
        },
      } as never),
    ).resolves.toMatchObject({ exitCode: 0 });

    const missingParent = join(
      tmpdir(),
      `aaspai-opencode-lock-parent-${Date.now()}-${Math.random()}`,
      "lock",
    );
    process.env.AASPAI_OPENCODE_LOCK_PATH = missingParent;
    await expect(
      opencodeCli.execute({
        ...buildAdapterContext({
          prompt: "lock fs error",
          cwd: process.cwd(),
          runId: "run_lock_fs_error",
        }),
        config: { command: "runtime-opencode" },
        execution: {
          run: async () => ({
            exitCode: 0,
            timedOut: false,
            stdout: "",
            stderr: "",
            startedAt: "",
            finishedAt: "",
            durationMs: 1,
          }),
        },
      } as never),
    ).rejects.toThrow();

    const livePath = makeLockPath("lock-live");
    process.env.AASPAI_OPENCODE_LOCK_PATH = livePath;
    await writeFile(livePath, `${process.ppid}@live@owner`, "utf8");
    try {
      await expect(
        opencodeCli.execute({
          ...buildAdapterContext({
            prompt: "lock timeout",
            cwd: process.cwd(),
            runId: "run_lock_timeout",
          }),
          config: { command: "runtime-opencode" },
        } as never),
      ).rejects.toThrow("cross-process lock timeout");
    } finally {
      await rm(livePath, { force: true });
    }

    const epermPath = makeLockPath("lock-eperm");
    process.env.AASPAI_OPENCODE_LOCK_PATH = epermPath;
    await writeFile(epermPath, `${process.pid + 1}@protected@owner`, "utf8");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("permission denied"), { code: "EPERM" });
    });
    try {
      await expect(
        opencodeCli.execute({
          ...buildAdapterContext({
            prompt: "lock eperm",
            cwd: process.cwd(),
            runId: "run_lock_eperm",
          }),
          config: { command: "runtime-opencode" },
        } as never),
      ).rejects.toThrow("cross-process lock timeout");
    } finally {
      kill.mockRestore();
      await rm(epermPath, { force: true });
      delete process.env.AASPAI_OPENCODE_LOCK_PATH;
    }
  }, 30_000);

  it("covers isolated default OpenCode filesystem roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaspai-opencode-defaults-"));
    const oldTemp = process.env.TEMP;
    const oldTmp = process.env.TMP;
    const oldHome = process.env.HOME;
    const oldConfigDir = process.env.AASPAI_OPENCODE_CONFIG_DIR;
    const oldAuthPath = process.env.AASPAI_OPENCODE_AUTH_PATH;
    process.env.TEMP = root;
    process.env.TMP = root;
    delete process.env.HOME;
    delete process.env.AASPAI_OPENCODE_CONFIG_DIR;
    delete process.env.AASPAI_OPENCODE_AUTH_PATH;
    try {
      vi.resetModules();
      const fresh = await import("../src/drivers/opencode-cli/implementation.js");
      expect(fresh.getAuthFilePath()).toContain(root);
      expect(fresh.writeOpencodeMcpServers({} as never).path).toContain(root);
      expect(fresh.writeOpencodeAgentFile("plain", "body").path).toContain(root);
      expect(fresh.writeOpencodeSkill("plain", "body").path).toContain(root);
      expect(
        fresh.addOpencodeProvider("provider", { baseUrl: "https://provider.test" }).path,
      ).toContain(root);
    } finally {
      if (oldTemp === undefined) delete process.env.TEMP;
      else process.env.TEMP = oldTemp;
      if (oldTmp === undefined) delete process.env.TMP;
      else process.env.TMP = oldTmp;
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      if (oldConfigDir === undefined) delete process.env.AASPAI_OPENCODE_CONFIG_DIR;
      else process.env.AASPAI_OPENCODE_CONFIG_DIR = oldConfigDir;
      if (oldAuthPath === undefined) delete process.env.AASPAI_OPENCODE_AUTH_PATH;
      else process.env.AASPAI_OPENCODE_AUTH_PATH = oldAuthPath;
      await rm(root, { recursive: true, force: true });
    }
  });
});
