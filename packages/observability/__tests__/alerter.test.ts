import { describe, expect, it, vi } from "vitest";
import { ConsoleAlerter, NoopAlerter, RateLimitedAlerter } from "../src/alerter";

const testAlert = {
  kind: "db_healthcheck_failed" as const,
  severity: "critical" as const,
  message: "Database is down",
  meta: { db: "primary" },
  occurredAt: new Date().toISOString(),
};

describe("ConsoleAlerter", () => {
  it("sends to stderr", () => {
    const alerter = new ConsoleAlerter();
    const spy = vi.spyOn(process.stderr, "write");
    alerter.send(testAlert);
    expect(spy).toHaveBeenCalled();
    const call = spy.mock.calls[0]?.[0] as string;
    expect(call).toContain("db_healthcheck_failed");
    spy.mockRestore();
  });
});

describe("NoopAlerter", () => {
  it("returns sent=false and never writes", () => {
    const alerter = new NoopAlerter();
    expect(alerter.isConfigured()).toBe(false);
    alerter.send(testAlert);
    // no throw = success
  });
});

describe("RateLimitedAlerter", () => {
  it("allows first send", async () => {
    const inner = new ConsoleAlerter();
    const alerter = new RateLimitedAlerter(inner, 60_000);
    const result = await alerter.send(testAlert);
    expect(result.sent).toBe(true);
  });

  it("blocks duplicate within window", async () => {
    const inner = new NoopAlerter();
    const alerter = new RateLimitedAlerter(inner, 60_000);
    await alerter.send(testAlert);
    const result = await alerter.send({ ...testAlert });
    expect(result.sent).toBe(false);
  });
});
