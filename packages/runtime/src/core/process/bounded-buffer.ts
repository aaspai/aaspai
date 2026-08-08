/**
 * Byte-accurate bounded output buffer. Tracks real bytes, never
 * `string.length`, and keeps the most recent `maxBytes` bytes with an
 * optional head-reserved slice so early output is not lost.
 *
 * Modes:
 *  - "tail"    keep last `maxBytes`
 *  - "head+tail" keep first `headBytes` + last `(maxBytes - headBytes)`
 */
import { createHash } from "node:crypto";

export interface BoundedByteBufferOptions {
  maxBytes: number;
  mode?: "tail" | "head+tail";
  headBytes?: number;
  truncationMarker?: Uint8Array;
}

const DEFAULT_TRUNCATION_MARKER = new TextEncoder().encode("\n... [truncated] ...\n");

export class BoundedByteBuffer {
  readonly maxBytes: number;
  readonly mode: "tail" | "head+tail";
  readonly headBytes: number;
  readonly truncationMarker: Uint8Array;
  private headChunks: Uint8Array[] = [];
  private tailChunks: Uint8Array[] = [];
  private headBytesUsed = 0;
  private tailBytes = 0;
  private truncated = false;
  private total = 0;
  private readonly hash = createHash("sha256");

  constructor(options: BoundedByteBufferOptions) {
    this.maxBytes = Math.max(1, options.maxBytes);
    this.mode = options.mode ?? "tail";
    this.headBytes =
      this.mode === "head+tail"
        ? Math.max(0, Math.min(options.headBytes ?? Math.floor(this.maxBytes / 8), this.maxBytes))
        : 0;
    this.truncationMarker = options.truncationMarker ?? DEFAULT_TRUNCATION_MARKER;
  }

  get size(): number {
    return this.headBytesUsed + this.tailBytes;
  }

  get isTruncated(): boolean {
    return this.truncated;
  }

  get totalBytes(): number {
    return this.total;
  }

  get sha256(): string {
    return this.hash.copy().digest("hex");
  }

  /** Marker that callers may append to a human-facing tail. Kept separate
   * from `toUint8Array()` so binary consumers never receive text bytes that
   * were not produced by the child process. */
  get overflowMarker(): Uint8Array {
    return this.truncationMarker.slice();
  }

  append(input: Uint8Array): void {
    if (input.byteLength === 0) return;
    this.total += input.byteLength;
    this.hash.update(input);
    if (this.mode === "tail") {
      this.tailChunks.push(input);
      this.tailBytes += input.byteLength;
      if (this.tailBytes > this.maxBytes) this.truncated = true;
      this.dropOldestTail();
      return;
    }
    // head+tail: capture the first headBytes of the whole stream, then
    // keep only the last (maxBytes - headBytes) as the tail.
    const before = this.headBytesUsed + this.tailBytes;
    if (this.headBytesUsed < this.headBytes) {
      const remaining = this.headBytes - this.headBytesUsed;
      const headSlice = input.subarray(0, Math.min(remaining, input.byteLength));
      if (headSlice.byteLength > 0) {
        this.headChunks.push(headSlice);
        this.headBytesUsed += headSlice.byteLength;
      }
    }
    const tailBudget = this.maxBytes - this.headBytes;
    if (tailBudget > 0) {
      const tailSlice = input.subarray(Math.max(0, input.byteLength - tailBudget));
      this.tailChunks.push(tailSlice);
      this.tailBytes += tailSlice.byteLength;
      this.dropOldestTail();
    }
    if (before + input.byteLength > this.maxBytes || input.byteLength > this.maxBytes) {
      this.truncated = true;
    }
  }

  private dropOldestTail(): void {
    if (this.tailBytes <= this.maxBytes - this.headBytes) return;
    let excess = this.tailBytes - (this.maxBytes - this.headBytes);
    const kept: Uint8Array[] = [];
    for (const chunk of this.tailChunks) {
      if (excess <= 0) {
        kept.push(chunk);
        continue;
      }
      if (chunk.byteLength <= excess) {
        excess -= chunk.byteLength;
        continue;
      }
      kept.push(chunk.subarray(excess));
      excess = 0;
    }
    this.tailChunks = kept;
    this.tailBytes = kept.reduce((acc, c) => acc + c.byteLength, 0);
  }

  /** Concatenated bytes (bounded). */
  toUint8Array(): Uint8Array {
    const total = this.headBytesUsed + this.tailBytes;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.headChunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    for (const chunk of this.tailChunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  /** UTF-8 decode of the bounded bytes. */
  toString(encoding: "utf8" = "utf8"): string {
    return new TextDecoder(encoding).decode(this.toUint8Array());
  }
}

/** Convenience: build a tail buffer sized in bytes. */
export function createBoundedByteBuffer(
  maxBytes: number,
  options?: Omit<BoundedByteBufferOptions, "maxBytes">,
): BoundedByteBuffer {
  return new BoundedByteBuffer({ maxBytes, ...options });
}
