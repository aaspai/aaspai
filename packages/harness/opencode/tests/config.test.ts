import { describe, expect, it } from "vitest";
import {
  buildOpencodeJson,
  prepareConfigInjection,
  resolveOpenCodeConfig,
} from "../src/config/index.js";

describe("OpenCode production configuration", () => {
  it("resolves only the server-facing defaults", () => {
    expect(resolveOpenCodeConfig({})).toMatchObject({
      model: "opencode-go/mimo-v2.5",
      title: "OpenCode Session",
      commandArgs: [],
      transport: "server",
      timeoutSec: 86_400,
      graceSec: 15,
      pure: false,
      nativeConfig: {},
      disableProjectConfig: true,
    });
  });

  it("rejects legacy control/config fields", () => {
    expect(() => resolveOpenCodeConfig({ auth: {}, workingDir: "C:/" })).toThrow();
  });

  it("merges permission policy into caller-prepared native config", () => {
    const config = resolveOpenCodeConfig({
      nativeConfig: { provider: { openai: { options: { apiKey: "${OPENAI_API_KEY}" } } } },
      permissions: { bash: "ask" },
      pure: true,
    });
    expect(buildOpencodeJson(config)).toEqual({
      provider: { openai: { options: { apiKey: "${OPENAI_API_KEY}" } } },
      permission: { bash: "ask" },
      pure: true,
    });
  });

  it("passes prepared config through an ephemeral environment value", () => {
    const config = resolveOpenCodeConfig({ nativeConfig: { model: "${MODEL}" } });
    const injection = prepareConfigInjection(config);
    expect(injection.extraEnv.OPENCODE_CONFIG_CONTENT).toContain('"model":"${MODEL}"');
    expect(injection.extraEnv.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
    expect(() =>
      prepareConfigInjection(resolveOpenCodeConfig({ nativeConfig: { apiKey: "sk-live" } })),
    ).toThrow(/resolved secret/);
  });
});
