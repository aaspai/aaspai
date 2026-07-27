import { describe, expect, it } from "vitest";
import { agentAdapterConfig } from "../src/sessions.js";

describe("agentAdapterConfig", () => {
  it("passes the agent model to the provider while preserving explicit adapter overrides", () => {
    expect(agentAdapterConfig({ model: "gpt-5", adapterConfig: { timeoutMs: 1_000 } })).toEqual({
      model: "gpt-5",
      timeoutMs: 1_000,
    });
    expect(
      agentAdapterConfig({
        model: "gpt-5",
        adapterConfig: { model: "gpt-5-codex" },
      }),
    ).toEqual({ model: "gpt-5-codex" });
  });
});
