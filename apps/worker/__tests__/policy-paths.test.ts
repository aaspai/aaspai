import { describe, expect, it } from "vitest";
import { changedPathsFromStatus } from "../src/daemon";

describe("post-run path policy input", () => {
  it("extracts modified, untracked, and both sides of renamed paths", () => {
    expect(
      changedPathsFromStatus([" M auth/session.ts", "?? .env", "R  src/old.ts -> payments/new.ts"]),
    ).toEqual(["auth/session.ts", ".env", "src/old.ts", "payments/new.ts"]);
  });
});
