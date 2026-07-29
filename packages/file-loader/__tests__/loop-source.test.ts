import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileLoopConfigSource } from "../src/loop-source";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("FileLoopConfigSource", () => {
  it("parses YAML policy and preserves LOOP.md instructions", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaspai-loop-source-"));
    directories.push(root);
    const loopDir = join(root, "safe-loop");
    await mkdir(loopDir);
    await writeFile(
      join(loopDir, "LOOP.md"),
      `---
id: loop/safe-loop
type: LoopPattern
title: Safe loop
description: Runs safely.
timestamp: 2026-07-29T00:00:00Z
schedule: { kind: manual }
agent: agent/operator
autonomyLevel: L1
---
Inspect the project and report findings.
`,
    );
    await writeFile(join(loopDir, "gate.yaml"), 'denylist: [".env"]\n');
    await writeFile(join(loopDir, "budget.yaml"), "perRun:\n  tokens: 100\n");

    const source = new FileLoopConfigSource(root);
    await source.start();
    const loop = await source.get("loop/safe-loop");
    await source.stop();

    expect(JSON.parse(loop.gateJson)).toMatchObject({ denylist: [".env"] });
    expect(JSON.parse(loop.budgetJson)).toMatchObject({ perRun: { tokens: 100 } });
    expect(JSON.parse(loop.configJson)).toMatchObject({
      instructions: "Inspect the project and report findings.",
    });
  });

  it("fails closed on invalid gate YAML", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaspai-loop-source-"));
    directories.push(root);
    const loopDir = join(root, "bad-loop");
    await mkdir(loopDir);
    await writeFile(
      join(loopDir, "LOOP.md"),
      `---
id: loop/bad-loop
type: LoopPattern
title: Bad loop
description: Invalid policy.
timestamp: 2026-07-29T00:00:00Z
schedule: { kind: manual }
agent: agent/operator
---
Body
`,
    );
    await writeFile(join(loopDir, "gate.yaml"), "denylist: unsafe-string\n");

    const source = new FileLoopConfigSource(root);
    await source.start();
    expect(await source.has("loop/bad-loop")).toBe(false);
    await source.stop();
  });
});
