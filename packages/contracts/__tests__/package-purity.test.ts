import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as contractExports from "@aaspai/contracts";
import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("contracts package purity", () => {
  it("has only the approved runtime dependency", () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(["zod"]);
  });

  it("does not import AASPAI internals or forbidden runtime frameworks", () => {
    const forbidden =
      /from\s+["'](?:@aaspai\/(?!contracts)|next|@trpc|drizzle|dockerode|temporal|@octokit|better-auth)/;
    const sourceFiles = readdirSync(join(packageRoot, "src")).filter((file) =>
      file.endsWith(".ts"),
    );
    const violations = sourceFiles.filter((file) =>
      forbidden.test(readFileSync(join(packageRoot, "src", file), "utf8")),
    );
    expect(violations).toEqual([]);
  });

  it("resolves the public package export", () => {
    expect(contractExports.CONTRACT_PROTOCOL_VERSION).toBe(1);
    expect(contractExports.aaspaiEventSchema).toBeDefined();
    expect(contractExports.sandboxSpecSchema).toBeDefined();
  });
});
