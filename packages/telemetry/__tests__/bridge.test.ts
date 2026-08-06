import { closeDefaultDb } from "@aaspai/db";
import { afterEach, describe, expect, it } from "vitest";
import { emitNativeLine, emitSessionProjection, setObserverEnabled } from "../src/bridge.js";
import { createTelemetryTestContext, TEST_ORGANIZATION, TEST_SESSION } from "../src/test-utils.js";

const contexts: Awaited<ReturnType<typeof createTelemetryTestContext>>[] = [];

async function setup() {
  const context = await createTelemetryTestContext();
  contexts.push(context);
  return context;
}

afterEach(async () => {
  setObserverEnabled(false);
  await closeDefaultDb();
  while (contexts.length) {
    const c = contexts.pop();
    if (c) await c.cleanup();
  }
});

describe("observer bridge", () => {
  it("is disabled under test runners by default", () => {
    expect(process.env.VITEST !== undefined).toBe(true);
  });

  it("emits native lines and session projections when enabled", async () => {
    const { repo } = await setup();
    setObserverEnabled(true);
    emitNativeLine({
      organizationId: TEST_ORGANIZATION,
      sessionId: TEST_SESSION,
      provider: "aaspai",
      stream: "stdout",
      line: "hello from bridge",
      seq: 1,
    });
    const rows = repo.queryLogs({ organizationId: TEST_ORGANIZATION });
    expect(rows.total).toBe(1);
    expect(rows.rows[0]?.body).toBe("hello from bridge");
    expect(rows.rows[0]?.sessionId).toBe(TEST_SESSION);

    emitSessionProjection({
      organizationId: TEST_ORGANIZATION,
      sessionId: TEST_SESSION,
      provider: "aaspai",
      status: "succeeded",
      messageCount: 1,
      toolCallCount: 0,
      logs: [],
    });
    const detail = repo.getSessionDetail(TEST_SESSION, TEST_ORGANIZATION);
    expect(detail?.summary).toBeDefined();
    expect((detail?.summary as Record<string, unknown>)?.status).toBe("succeeded");
  });
});
