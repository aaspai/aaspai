import { describe, expect, it } from "vitest";
import { randomBytes, sha256Hex, timingSafeEqual } from "../src";

describe("crypto primitives", () => {
  it("matches the SHA-256 known vector", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("returns secure bounded random bytes", () => {
    expect(randomBytes(32)).toHaveLength(32);
    expect(() => randomBytes(0)).toThrow(RangeError);
    expect(() => randomBytes(1_048_577)).toThrow(RangeError);
  });

  it("compares equal-length inputs safely", () => {
    expect(timingSafeEqual("same", "same")).toBe(true);
    expect(timingSafeEqual("same", "different")).toBe(false);
    expect(timingSafeEqual("short", "longer")).toBe(false);
  });
});
