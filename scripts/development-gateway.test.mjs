import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { startDevelopmentGateway } from "./development-gateway.mjs";

test("starts and stops the local Docker gateway without Daytona", async () => {
  const gateway = await startDevelopmentGateway(resolve(import.meta.dirname, ".."), {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    OPENROUTER_API_KEY: "test-only",
  });
  try {
    assert.match(gateway.env.AASPAI_GATEWAY_CONTROL_URL, /^http:\/\/127\.0\.0\.1:/);
    assert.match(gateway.env.AASPAI_GATEWAY_AGENT_BASE_URL, /^http:\/\/host\.docker\.internal:/);
    const response = await fetch(`${gateway.env.AASPAI_GATEWAY_CONTROL_URL}/health`);
    assert.equal(response.status, 200);
  } finally {
    await gateway.stop();
  }
});
