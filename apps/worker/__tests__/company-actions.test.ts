import { describe, expect, it } from "vitest";
import {
  CODEX_COMPANY_ACTION_CLIENT_SOURCE,
  COMPANY_ACTION_TOOL_SOURCE,
  companyActionPayload,
  companyActions,
  missingRequiredCompanyActions,
  requiredCompanyActionsForHire,
} from "../src/company-actions.js";

describe("company actions", () => {
  it("keeps Codex company payloads out of shell arguments", () => {
    expect(CODEX_COMPANY_ACTION_CLIENT_SOURCE).toContain("process.stdin");
    expect(CODEX_COMPANY_ACTION_CLIENT_SOURCE).not.toContain("process.argv");
  });

  it("sends OpenCode's provider session identity with company mutations", () => {
    expect(COMPANY_ACTION_TOOL_SOURCE).toContain("async execute({ payload }, context)");
    expect(COMPANY_ACTION_TOOL_SOURCE).toContain(
      '"x-aaspai-provider-session-id": context.sessionID',
    );
  });

  it("requires a persisted milestone sequence when starting a process", () => {
    expect(COMPANY_ACTION_TOOL_SOURCE).toContain('"milestoneSequence":1');
    expect(COMPANY_ACTION_TOOL_SOURCE).toContain('"definition":{');
    expect(COMPANY_ACTION_TOOL_SOURCE).toContain("ceo, cto, cmo, cfo");
    expect(COMPANY_ACTION_TOOL_SOURCE).toContain('"role":"pm"');
    expect(COMPANY_ACTION_TOOL_SOURCE).toContain('"workKind":"general"');
    expect(COMPANY_ACTION_TOOL_SOURCE).toContain('"createdAt":"');
    expect(COMPANY_ACTION_TOOL_SOURCE).toContain(
      '"steps":[{"id":"step/execute","agent":"agent/project-specialist"',
    );
    const action = {
      type: "define_and_start_process",
      projectId: "project/growth",
      milestoneSequence: 1,
      definition: {
        id: "process/growth",
        organizationId: "org/test",
        revision: 1,
        contentHash: "growth-v1",
        name: "Growth loop",
        description: "Run the smallest growth loop.",
        steps: [
          {
            id: "step/research",
            agent: "agent/researcher",
            dependsOn: [],
            prompt: "Research one segment.",
            skills: [],
            tools: [],
            workKind: "general",
            deliveryMode: "none",
            timeoutMs: 60_000,
            maxAttempts: 1,
            acceptanceCriteria: "Evidence is persisted.",
            failureAction: "escalate",
            approvalPolicy: {},
          },
        ],
        maxDurationMs: 300_000,
        maxAttempts: 1,
        createdAt: "2026-08-02T00:00:00.000Z",
      },
    };
    expect(companyActionPayload({ actions: [action] })).toEqual([action]);
    const missingSequence = { ...action } as Record<string, unknown>;
    delete missingSequence.milestoneSequence;
    expect(() => companyActionPayload({ actions: [missingSequence] })).toThrow("invalid");
    expect(
      companyActionPayload({
        actions: [{ ...action, policy: { schedule: { kind: "interval", seconds: 86_400 } } }],
      }),
    ).toHaveLength(1);
    expect(() =>
      companyActionPayload({
        actions: [{ ...action, policy: { schedule: { kind: "interval" } } }],
      }),
    ).toThrow("policy.schedule must be a valid interval or cron schedule");
    expect(() =>
      companyActionPayload({
        actions: [{ ...action, policy: { schedule: { kind: "manual" } } }],
      }),
    ).toThrow("policy.schedule must be a valid interval or cron schedule");
  });

  it("requires a new project manager to hire a specialist before starting its process", () => {
    expect(requiredCompanyActionsForHire({ projectRole: "manager" }, "project/growth")).toEqual([
      { type: "hire_and_delegate", projectId: "project/growth" },
      { type: "create_milestone", projectId: "project/growth" },
      { type: "define_and_start_process", projectId: "project/growth" },
    ]);
    expect(requiredCompanyActionsForHire({ projectRole: "member" }, "project/growth")).toEqual([]);
  });

  it("accepts a typed final-line action from a CLI without custom tools", () => {
    const payload = {
      actions: [
        {
          type: "create_milestone",
          projectId: "project/growth",
          title: "Qualified pipeline",
          outcome: "Ten qualified opportunities",
          sequence: 1,
          acceptance: { qualified: 10 },
        },
      ],
    };
    expect(
      companyActions({
        exitCode: 0,
        timedOut: false,
        summary: `Done\nAASPAI_COMPANY_ACTIONS=${JSON.stringify(payload)}`,
      }),
    ).toEqual(payload.actions);
  });

  it("accepts bounded structured hires and rejects untrusted provider output", () => {
    const action = {
      type: "hire_and_delegate",
      agentId: "agent/market-researcher",
      title: "Market Researcher",
      role: "researcher",
      description: "Validates demand.",
      workTitle: "Validate the offer",
      workDescription: "Collect evidence.",
    };
    expect(
      companyActions({
        exitCode: 0,
        timedOut: false,
        resultJson: { dryRun: true, companyActions: [action] },
      }),
    ).toEqual([action]);
    expect(
      companyActions({
        exitCode: 0,
        timedOut: false,
        resultJson: { dryRun: false, companyActions: [action] },
      }),
    ).toEqual([]);
    expect(
      companyActions({
        exitCode: 0,
        timedOut: false,
        resultJson: {
          companyActions: [{ actions: [action] }],
        },
      }),
    ).toEqual([action]);
    expect(companyActionPayload({ actions: [action] })).toEqual([action]);
    expect(
      companyActionPayload({
        actions: [
          {
            type: "create_milestone",
            projectId: "project/growth",
            title: "Qualified pipeline",
            outcome: "Ten qualified opportunities",
            sequence: 1,
            acceptance: { qualified: 10 },
          },
        ],
      }),
    ).toHaveLength(1);
    expect(() =>
      companyActionPayload({ actions: [{ ...action, agentId: "../../escape" }] }),
    ).toThrow("invalid");
    expect(() => companyActionPayload({ actions: [{ ...action, agentId: "agent/ceo" }] })).toThrow(
      "invalid",
    );
    expect(() =>
      companyActionPayload({
        actions: [
          {
            ...action,
            role: "cmo",
            workTitle: "Build a lead campaign",
          },
        ],
      }),
    ).toThrow(
      "commercial work requires non-empty artifactPaths, citationPaths, and commercialClaimPaths",
    );
  });

  it("matches every required action to one submitted project action", () => {
    const first = {
      type: "hire_and_delegate" as const,
      agentId: "agent/first",
      title: "First",
      role: "researcher" as const,
      description: "Researches the first project.",
      workTitle: "Research project one",
      workDescription: "Produce evidence.",
      projectId: "project/one",
    };
    const second = { ...first, agentId: "agent/second", projectId: "project/two" };
    const required = [
      { type: "hire_and_delegate", projectId: "project/one" },
      { type: "hire_and_delegate", projectId: "project/two" },
    ];
    expect(missingRequiredCompanyActions(required, [first, second])).toEqual([]);
    expect(missingRequiredCompanyActions(required, [first])).toEqual([
      { type: "hire_and_delegate", projectId: "project/two" },
    ]);
  });
});
