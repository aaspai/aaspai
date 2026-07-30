import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileAgentConfigSource } from "../src/agent-source";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("FileAgentConfigSource", () => {
  it("waits for the initial scan when start is called concurrently", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaspai-agent-source-"));
    directories.push(root);
    const agentDir = join(root, "tester");
    await mkdir(agentDir);
    await writeFile(
      join(agentDir, "AGENT.md"),
      `---
id: agent/tester
type: Agent
title: Tester
description: Verifies delivery.
timestamp: 2026-07-24T00:00:00Z
adapter: dry_run_local
role: qa
---
Verify the outcome.
`,
    );

    const source = new FileAgentConfigSource(root);
    const firstStart = source.start();
    await source.start();
    const agent = await source.get("agent/tester");
    await firstStart;
    await source.stop();

    expect(agent.systemPrompt).toContain("Verify the outcome.");
  });

  it("separates adapter and runtime config sidecars", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaspai-agent-source-"));
    directories.push(root);
    const agentDir = join(root, "tester");
    await mkdir(agentDir);
    await writeFile(
      join(agentDir, "AGENT.md"),
      `---
id: agent/tester
type: Agent
title: Tester
description: Verifies delivery.
timestamp: 2026-07-24T00:00:00Z
adapter: codex_local
role: qa
---

# Tester
Verify the outcome.
`,
    );
    await writeFile(
      join(agentDir, "config.yaml"),
      "adapterConfig:\n  model: gpt-5-codex\nruntimeConfig:\n  kind: local\n",
    );

    const source = new FileAgentConfigSource(root);
    await source.start();
    const agent = await source.get("agent/tester");
    await source.stop();

    expect(agent.adapterConfig).toEqual({ model: "gpt-5-codex" });
    expect(agent.runtimeConfig).toEqual({ kind: "local" });
  });

  it("does not let empty sidecars erase frontmatter runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaspai-agent-source-"));
    directories.push(root);
    const agentDir = join(root, "tester");
    await mkdir(agentDir);
    await writeFile(
      join(agentDir, "AGENT.md"),
      `---
id: agent/tester
type: Agent
title: Tester
description: Verifies delivery.
timestamp: 2026-07-24T00:00:00Z
adapter: codex_local
role: qa
runtime:
  default: { kind: local }
---
Verify the outcome.
`,
    );
    await writeFile(join(agentDir, "config.yaml"), "adapterConfig: {}\nruntimeConfig: {}\n");

    const source = new FileAgentConfigSource(root);
    await source.start();
    const agent = await source.get("agent/tester");
    await source.stop();

    expect(agent.runtimeConfig).toEqual({ default: { kind: "local" } });
    expect(agent.adapterConfig).toEqual({});
  });
});
