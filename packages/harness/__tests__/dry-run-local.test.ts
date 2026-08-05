import { describe, expect, it } from "vitest";
import { dryRunLocal, dryRunLocalInfo } from "../src/drivers/dry-run-local/index.js";

describe("dry_run_local adapter", () => {
  it("declares itself ready and uses no API key", () => {
    expect(dryRunLocalInfo.type).toBe("dry_run_local");
    expect(dryRunLocalInfo.status).toBe("ready");
    expect(dryRunLocalInfo.transport).toBe("local_subprocess");
  });

  it("synthesizes a plan from the prompt", async () => {
    const onLog = async (_stream: "stdout" | "stderr", _chunk: string) => {};
    const result = await dryRunLocal.execute({
      protocolVersion: 1 as const,
      runId: "run_1",
      organizationId: "default",
      agent: {
        id: "agent/operator",
        organizationId: "default",
        name: "Operator",
        adapterType: "dry_run_local",
        adapterConfig: {},
      },
      runtime: {},
      config: {},
      context: { cwd: "/tmp", prompt: "Review the auth middleware" },
      onLog,
      onMeta: async () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.sessionId).toMatch(/^dry_/);
    expect(result.summary).toContain("Plan");
    expect(result.usage?.inputTokens).toBeGreaterThan(0);
    expect(result.usage?.outputTokens).toBeGreaterThan(0);
    expect(result.usageBasis).toBe("per_run");
    expect(result.costUsd).toBe(0);
  });

  it("testEnvironment always returns ok", async () => {
    const result = await dryRunLocal.testEnvironment({ config: {}, cwd: "/tmp" });
    expect(result.ok).toBe(true);
    expect(result.checks.length).toBeGreaterThan(0);
  });

  it("emits a structured CEO hire and delegation for a company objective", async () => {
    const result = await dryRunLocal.execute({
      protocolVersion: 1 as const,
      runId: "run_company",
      organizationId: "default",
      agent: {
        id: "agent/ceo",
        organizationId: "default",
        name: "CEO",
        adapterType: "dry_run_local",
        adapterConfig: {},
      },
      runtime: {},
      config: {},
      context: {
        cwd: "/tmp",
        role: "ceo",
        prompt: "Company objective: validate the agency offer and build the operating plan.",
      },
      onLog: async () => {},
      onMeta: async () => {},
    });

    expect(result.resultJson).toMatchObject({
      dryRun: true,
      companyActions: [
        {
          type: "hire_and_delegate",
          agentId: "agent/market-researcher",
          role: "researcher",
        },
      ],
    });
  });

  it("replays scripted company controls for deterministic simulations", async () => {
    const actions = [
      {
        type: "create_milestone",
        projectId: "project/sim",
        title: "First outcome",
        outcome: "Verified",
        sequence: 1,
        acceptance: { reports: 1 },
      },
    ];
    const result = await dryRunLocal.execute({
      protocolVersion: 1 as const,
      runId: "run_simulation",
      organizationId: "default",
      agent: {
        id: "agent/ceo",
        organizationId: "default",
        name: "CEO",
        adapterType: "dry_run_local",
        adapterConfig: {},
      },
      runtime: {},
      config: {},
      context: {
        cwd: "/tmp",
        role: "ceo",
        prompt: `AASPAI_SIMULATION_COMPANY_ACTIONS=${JSON.stringify(actions)}`,
      },
      onLog: async () => {},
      onMeta: async () => {},
    });

    expect(result.resultJson?.companyActions).toEqual(actions);
  });

  it("returns a structured verdict for deterministic checker runs", async () => {
    const result = await dryRunLocal.execute({
      protocolVersion: 1 as const,
      runId: "run_checker",
      organizationId: "default",
      agent: {
        id: "agent/manager",
        organizationId: "default",
        name: "Manager",
        adapterType: "dry_run_local",
        adapterConfig: {},
      },
      runtime: {},
      config: {},
      context: {
        cwd: "/tmp",
        role: "ceo",
        prompt:
          'Independently verify this work. End with AASPAI_CHECK_RESULT={"verdict":"passed|failed|concerns","summary":"brief"}',
      },
      onLog: async () => {},
      onMeta: async () => {},
    });

    expect(result.summary).toContain('"verdict":"passed"');
  });

  it("covers CEO conversation intents, role inference, history, and session reuse", async () => {
    const ask = async (prompt: string, role = "ceo", extra: Record<string, unknown> = {}) =>
      dryRunLocal.execute({
        protocolVersion: 1 as const,
        runId: `run_${prompt.slice(0, 8)}`,
        organizationId: "default",
        agent: {
          id: "agent/ceo",
          organizationId: "default",
          name: "CEO",
          adapterType: "dry_run_local",
          adapterConfig: {},
        },
        runtime: extra.runtime ?? {},
        config: {},
        context: {
          cwd: "/tmp",
          prompt,
          role,
          ...(extra.systemPrompt ? { systemPrompt: extra.systemPrompt } : {}),
        },
        ...(extra.noLog ? {} : { onLog: async () => {} }),
        ...(extra.noMeta ? {} : { onMeta: async () => {} }),
      } as never);

    expect((await ask("hello")).summary).toContain("chief of staff");
    expect((await ask("what is everyone working on?")).summary).toContain("aaspai state");
    expect((await ask("assign this to developer: fix it")).summary).toContain("route");
    expect((await ask("what should we do next?")).summary).toContain("Got it");
    expect((await ask("do not hire anyone")).resultJson).toMatchObject({ companyActions: [] });

    for (const [phrase, expected] of [
      ["marketing manager", "cmo"],
      ["design lead", "designer"],
      ["backend engineer", "engineer"],
      ["qa tester", "qa"],
      ["product manager", "pm"],
      ["data analyst", "researcher"],
      ["infra lead", "devops"],
      ["security officer", "security"],
      ["finance cfo", "cfo"],
      ["cto", "cto"],
      ["chief executive ceo", "ceo"],
      ["new hire", "general"],
    ] as const) {
      expect((await ask(`do not hire; hire a ${phrase}`)).summary).toContain(phrase);
      expect((await ask(`do not hire; hire a ${phrase}`)).resultJson).toMatchObject({
        text: expect.stringContaining(`(${expected})`),
      });
    }

    const history = await ask(
      "System\n\n---\n\nUser:\nold\n\nAssistant:\nanswer\n\nUser:\nreview this",
      "operator",
      {
        systemPrompt: "system prompt",
        runtime: { sessionId: "dry_previous" },
        noLog: true,
        noMeta: true,
      },
    );
    expect(history.sessionId).toBe("dry_previous");
    expect(history.sessionParams).toMatchObject({ resume: true });
    expect(history.resultJson).toMatchObject({ role: "operator" });
    expect((await ask("system\n\n---\n\nreview this", "operator")).summary).toContain("review");
    expect((await ask("User:\nreview this\n\nAssistant:\nold", "operator")).summary).toContain(
      "review",
    );
    expect(
      (
        await ask(
          "Please explain a completely unrelated architectural tradeoff in this deliberately long request that exceeds eighty characters and matches none of the special conversation intents.",
        )
      ).summary,
    ).toContain("Got it");
    expect((await ask("plain prompt", "operator", { systemPrompt: undefined })).summary).toContain(
      "triage",
    );
  });

  it("covers company action input guards and long plan previews", async () => {
    const base = {
      protocolVersion: 1 as const,
      runId: "run_guards",
      organizationId: "default",
      agent: {
        id: "agent/operator",
        organizationId: "default",
        name: "Operator",
        adapterType: "dry_run_local",
        adapterConfig: {},
      },
      runtime: {},
      config: {},
      context: { cwd: "/tmp", role: "operator" },
      onLog: async () => {},
    };
    await expect(
      dryRunLocal.execute({
        ...base,
        context: { cwd: "/tmp", role: "operator", prompt: "AASPAI_SIMULATION_COMPANY_ACTIONS={}" },
      } as never),
    ).rejects.toThrow("must be an array");
    const long = await dryRunLocal.execute({
      ...base,
      context: {
        cwd: "/tmp",
        role: "operator",
        systemPrompt: "",
        prompt: `deploy ${"x".repeat(600)}`,
      },
    } as never);
    expect(long.summary).toContain("deploy");
    expect((long.resultJson as { text: string }).text.length).toBeGreaterThan(400);

    const firstOnly = await dryRunLocal.execute({
      ...base,
      context: { cwd: "/tmp", role: "operator", prompt: "system\n\n---\n\nreview this" },
    } as never);
    expect(firstOnly.summary).toContain("review");

    const secondSeparator = await dryRunLocal.execute({
      ...base,
      context: {
        cwd: "/tmp",
        role: "operator",
        prompt: "system\n\n---\n\nreview this\n\n---\n\nknowledge",
      },
    } as never);
    expect(secondSeparator.summary).toContain("review");

    const noVerb = await dryRunLocal.execute({
      ...base,
      context: { cwd: "/tmp", role: "operator", prompt: "hello", systemPrompt: "" },
    } as never);
    expect(noVerb.summary).toContain("triage");

    const nullContext = await dryRunLocal.execute({
      ...base,
      context: null,
    } as never);
    expect(nullContext.exitCode).toBe(0);
    const missingFields = await dryRunLocal.execute({
      ...base,
      context: { cwd: "/tmp", prompt: undefined, systemPrompt: undefined, role: undefined },
    } as never);
    expect(missingFields.exitCode).toBe(0);
  });
});
