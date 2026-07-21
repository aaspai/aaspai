import type { AlertEvent, AlertKind, AlertSeverity } from "@aaspai/contracts/observability";

export type { AlertEvent, AlertKind, AlertSeverity };

/**
 * Alert transport interface. Implementations deliver alerts via
 * email, webhook, PagerDuty, etc.
 */
export interface Alerter {
  send(event: AlertEvent): Promise<{ sent: boolean }>;
  isConfigured(): boolean;
}

/**
 * Rate-limiting alert transport wrapper. Prevents the same alert
 * kind from being sent more than once per window.
 */
export class RateLimitedAlerter implements Alerter {
  #inner: Alerter;
  #windowMs: number;
  #lastSent = new Map<AlertKind, number>();

  constructor(inner: Alerter, windowMs = 30 * 60 * 1000) {
    this.#inner = inner;
    this.#windowMs = windowMs;
  }

  isConfigured(): boolean {
    return this.#inner.isConfigured();
  }

  async send(event: AlertEvent): Promise<{ sent: boolean }> {
    const last = this.#lastSent.get(event.kind) ?? 0;
    if (Date.now() - last < this.#windowMs) {
      return { sent: false };
    }
    const result = await this.#inner.send(event);
    if (result.sent) {
      this.#lastSent.set(event.kind, Date.now());
    }
    return result;
  }
}

/**
 * Console alerter that writes alerts to stderr. Used when no SMTP
 * or external alert transport is configured.
 */
export class ConsoleAlerter implements Alerter {
  isConfigured(): boolean {
    return true;
  }

  async send(event: AlertEvent): Promise<{ sent: boolean }> {
    const line = JSON.stringify({
      t: event.occurredAt,
      kind: event.kind,
      severity: event.severity,
      message: event.message,
      meta: event.meta,
    });
    process.stderr.write(`[alert] ${line}\n`);
    return { sent: true };
  }
}

/**
 * No-op alerter that silently discards events. Useful in tests
 * or when alerting is intentionally disabled.
 */
export class NoopAlerter implements Alerter {
  isConfigured(): boolean {
    return false;
  }

  async send(_event: AlertEvent): Promise<{ sent: boolean }> {
    return { sent: false };
  }
}
