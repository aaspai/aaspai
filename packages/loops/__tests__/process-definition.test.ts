import { describe, expect, it } from "vitest";
import { compileProcessDefinition } from "../src/process";

const step = (id: string, dependsOn: string[] = [], agent = `agent/${id}`) => ({
  id,
  agent,
  dependsOn,
  prompt: `Run ${id}`,
  skills: [],
  tools: [],
  timeoutMs: 10,
  maxAttempts: 1,
  acceptanceCriteria: `${id} passed`,
  failureAction: "stop" as const,
  approvalPolicy: {},
});

describe("file-defined process snapshots", () => {
  it("hashes and topologically sorts a planner/developer/tester DAG", () => {
    const process = compileProcessDefinition({
      id: "process/proof",
      organizationId: "org/test",
      name: "Proof",
      steps: [step("tester", ["developer"]), step("developer", ["planner"]), step("planner")],
    });
    expect(process.order).toEqual(["planner", "developer", "tester"]);
    expect(process.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(process.maxAttempts).toBe(3);
  });

  it("rejects cycles", () => {
    expect(() =>
      compileProcessDefinition({
        id: "process/cycle",
        organizationId: "org/test",
        name: "Cycle",
        steps: [step("a", ["b"]), step("b", ["a"])],
      }),
    ).toThrow(/cycle/);
  });
});
