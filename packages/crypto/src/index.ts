import {
  createHash,
  randomBytes as nodeRandomBytes,
  timingSafeEqual as nodeTimingSafeEqual,
} from "node:crypto";

export type ByteInput = string | Uint8Array;

function bytes(input: ByteInput): Uint8Array {
  return typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
}

/** Return a SHA-256 digest as lowercase hexadecimal. */
export function sha256Hex(input: ByteInput): string {
  return createHash("sha256").update(bytes(input)).digest("hex");
}

/** Generate cryptographically secure random bytes with a bounded request. */
export function randomBytes(length = 32): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 1 || length > 1_048_576) {
    throw new RangeError("Random byte length must be an integer from 1 to 1048576");
  }
  return new Uint8Array(nodeRandomBytes(length));
}

/** Compare byte strings without early-exit timing differences. */
export function timingSafeEqual(left: ByteInput, right: ByteInput): boolean {
  const leftBytes = bytes(left);
  const rightBytes = bytes(right);
  if (leftBytes.length !== rightBytes.length) return false;
  return nodeTimingSafeEqual(leftBytes, rightBytes);
}
