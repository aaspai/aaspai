import { describe, expect, it } from "vitest";
import {
  changedPathsFromStatus,
  gatewayControlUrl,
  parseCheckerVerdict,
  requiredCheckerCommit,
} from "../src/daemon";

describe("post-run path policy input", () => {
  it("extracts modified, untracked, and both sides of renamed paths", () => {
    expect(
      changedPathsFromStatus([" M auth/session.ts", "?? .env", "R  src/old.ts -> payments/new.ts"]),
    ).toEqual(["auth/session.ts", ".env", "src/old.ts", "payments/new.ts"]);
  });
});

describe("checker verdicts", () => {
  it("pins verification to immutable maker delivery evidence", () => {
    expect(requiredCheckerCommit({ deliveryCommitSha: "a".repeat(40) })).toBe("a".repeat(40));
    expect(() => requiredCheckerCommit({ deliveryCommitSha: null })).toThrow(/immutable/);
  });

  it("accepts only the explicit structured final verdict", () => {
    expect(
      parseCheckerVerdict(
        'tests passed\nAASPAI_CHECK_RESULT={"verdict":"passed","summary":"unit tests passed"}',
      ),
    ).toEqual({ status: "passed", summary: "unit tests passed" });
    expect(parseCheckerVerdict("Everything looks good")).toBeNull();
    expect(
      parseCheckerVerdict('AASPAI_CHECK_RESULT={"verdict":"maybe","summary":"unclear"}'),
    ).toBeNull();
  });
});

describe("gateway control URL", () => {
  it("requires HTTPS except for loopback development", () => {
    expect(gatewayControlUrl("https://gateway.example.test/")).toBe("https://gateway.example.test");
    expect(gatewayControlUrl("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000");
    expect(() => gatewayControlUrl("http://gateway.example.test")).toThrow(/HTTPS/);
  });
});
