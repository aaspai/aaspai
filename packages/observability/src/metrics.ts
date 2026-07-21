import type { MetricKind, MetricUnit } from "@aaspai/contracts/observability";

export type { MetricKind, MetricUnit };

/** A single metric data point. */
export interface MetricPoint {
  name: string;
  kind: MetricKind;
  unit: MetricUnit;
  value: number;
  labels?: Record<string, string>;
  timestamp: string;
  organizationId?: string;
}

/**
 * Metric registry — collects and exposes metrics for scraping
 * or export.
 */
export interface MetricRegistry {
  /** Record a counter increment. */
  increment(name: string, value?: number, labels?: Record<string, string>): void;
  /** Set a gauge value. */
  gauge(name: string, value: number, labels?: Record<string, string>): void;
  /** Record a histogram observation. */
  observe(name: string, value: number, labels?: Record<string, string>): void;
  /** Collect all registered metric points. */
  collect(): MetricPoint[];
  /** Reset all metrics (primarily for test isolation). */
  reset(): void;
}

/**
 * In-memory metric registry for testing and single-process use.
 * Metrics are stored in an array and can be collected/exported
 * via `collect()`.
 */
export class InMemoryMetricRegistry implements MetricRegistry {
  #points: MetricPoint[] = [];

  increment(name: string, value = 1, labels?: Record<string, string>): void {
    this.#points.push({
      name,
      kind: "counter",
      unit: "count",
      value,
      labels,
      timestamp: new Date().toISOString(),
    });
  }

  gauge(name: string, value: number, labels?: Record<string, string>): void {
    this.#points.push({
      name,
      kind: "gauge",
      unit: "count",
      value,
      labels,
      timestamp: new Date().toISOString(),
    });
  }

  observe(name: string, value: number, labels?: Record<string, string>): void {
    this.#points.push({
      name,
      kind: "histogram",
      unit: "ms",
      value,
      labels,
      timestamp: new Date().toISOString(),
    });
  }

  collect(): MetricPoint[] {
    return [...this.#points];
  }

  reset(): void {
    this.#points = [];
  }
}
