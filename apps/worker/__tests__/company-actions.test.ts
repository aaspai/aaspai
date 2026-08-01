import { describe, expect, it } from "vitest";
import {
  companyActionPayload,
  companyActions,
  missingRequiredCompanyActions,
} from "../src/company-actions.js";

describe("company actions", () => {
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
    ).toThrow("invalid");
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
