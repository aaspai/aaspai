/**
 * Ordered callback stream. Guarantees that for a stream of events, each
 * handler invocation is awaited before the next begins, and that all
 * pending handlers resolve before the stream is closed.
 *
 * This is the fix for the SSH/one-shot fire-and-forget ordering bug:
 * providers that declare `streaming: true` must surface output through
 * an ordered stream so `wait()` never resolves while callbacks are still
 * executing.
 */
export class OrderedStream<T> {
  private queue: T[] = [];
  private reading = false;
  private closed = false;
  private drainResolvers: Array<() => void> = [];
  private dropped = 0;

  constructor(
    private readonly handler: (item: T) => Promise<void> | void,
    private readonly options: {
      maxBuffer?: number;
      onOverflow?: (dropped: number) => Promise<void> | void;
    } = {},
  ) {}

  get isClosed(): boolean {
    return this.closed;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  /** Push an event; buffers until the handler drains it in order. */
  push(item: T): void {
    if (this.closed) return;
    const max = this.options.maxBuffer ?? 10_000;
    if (this.queue.length >= max) {
      // Safety valve: drop oldest so we never grow unbounded. The drop is
      // observable, which lets semantic streams fail closed and raw-log
      // streams emit an overflow record instead of silently losing data.
      this.queue.shift();
      this.dropped += 1;
      void Promise.resolve(this.options.onOverflow?.(this.dropped)).catch(() => undefined);
    }
    this.queue.push(item);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift();
        if (item === undefined) continue;
        try {
          await this.handler(item);
        } catch {
          // A throwing handler must not break ordering of subsequent events.
        }
      }
    } finally {
      this.reading = false;
      if (this.closed && this.queue.length === 0) {
        this.resolveDrainWaiters();
      }
    }
  }

  /**
   * Close the stream and await all buffered handlers. After close,
   * `push` is a no-op.
   */
  async close(): Promise<void> {
    this.closed = true;
    if (this.reading || this.queue.length > 0) {
      const drained = new Promise<void>((resolve) => this.drainResolvers.push(resolve));
      await this.drain();
      await drained;
    }
    await this.drain();
    this.resolveDrainWaiters();
  }

  private resolveDrainWaiters(): void {
    const resolvers = this.drainResolvers;
    this.drainResolvers = [];
    for (const resolve of resolvers) resolve();
  }
}

/** Alias matching the plan's naming for a byte stream hook. */
export type ByteStreamHook = (chunk: Uint8Array) => Promise<void> | void;

export function createOrderedStream<T>(
  handler: (item: T) => Promise<void> | void,
  options?: {
    maxBuffer?: number;
    onOverflow?: (dropped: number) => Promise<void> | void;
  },
): OrderedStream<T> {
  return new OrderedStream(handler, options);
}
