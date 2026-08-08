/**
 * Binary-safe helpers. Runtime boundaries use bytes; these helpers keep
 * conversions explicit and byte-accurate.
 */

export function toBytes(value: string | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) return value;
  return new TextEncoder().encode(value);
}

export function bytesToUtf8(value: Uint8Array): string {
  return new TextDecoder("utf8").decode(value);
}

/** Compare two byte sequences; throws with context if they differ. */
export function assertBytesEqual(actual: Uint8Array, expected: Uint8Array, label = "bytes"): void {
  if (actual.byteLength !== expected.byteLength) {
    throw new Error(
      `${label}: length mismatch (actual ${actual.byteLength}, expected ${expected.byteLength})`,
    );
  }
  for (let i = 0; i < actual.byteLength; i += 1) {
    if (actual[i] !== expected[i]) {
      throw new Error(`${label}: byte mismatch at offset ${i}`);
    }
  }
}
