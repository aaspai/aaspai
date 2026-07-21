import { describe, expect, it } from "vitest";
import { InMemoryMetricRegistry } from "../src/metrics";

describe("InMemoryMetricRegistry", () => {
  it("records counter increments", () => {
    const reg = new InMemoryMetricRegistry();
    reg.increment("test.counter", 1);
    reg.increment("test.counter", 1);
    const points = reg.collect();
    expect(points).toHaveLength(2);
    expect(points[0]!.name).toBe("test.counter");
    expect(points[0]!.kind).toBe("counter");
  });

  it("records gauge values", () => {
    const reg = new InMemoryMetricRegistry();
    reg.gauge("test.gauge", 42);
    const points = reg.collect();
    expect(points).toHaveLength(1);
    expect(points[0]!.value).toBe(42);
  });

  it("records histogram observations", () => {
    const reg = new InMemoryMetricRegistry();
    reg.observe("test.histogram", 150);
    const points = reg.collect();
    expect(points).toHaveLength(1);
    expect(points[0]!.kind).toBe("histogram");
  });

  it("supports labels", () => {
    const reg = new InMemoryMetricRegistry();
    reg.increment("test.counter", 1, { organization: "org-1" });
    const points = reg.collect();
    expect(points[0]!.labels).toEqual({ organization: "org-1" });
  });

  it("reset clears all metrics", () => {
    const reg = new InMemoryMetricRegistry();
    reg.increment("test.counter");
    reg.reset();
    expect(reg.collect()).toHaveLength(0);
  });
});
