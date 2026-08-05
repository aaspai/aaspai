import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { opencodeProviders } from "../src/drivers/opencode-cli/implementation.js";

const saved = {
  cli: process.env.OPENCODE_CLI,
  programFiles: process.env.ProgramFiles,
  appData: process.env.APPDATA,
};

afterEach(() => {
  if (saved.cli === undefined) delete process.env.OPENCODE_CLI;
  else process.env.OPENCODE_CLI = saved.cli;
  if (saved.programFiles === undefined) delete process.env.ProgramFiles;
  else process.env.ProgramFiles = saved.programFiles;
  if (saved.appData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = saved.appData;
});

describe("opencode binary resolution", () => {
  it("checks cached, Windows direct, cmd, and PATH fallback resolution", async () => {
    const base = join(tmpdir(), `aaspai-opencode-resolution-${process.pid}-${Date.now()}`);
    await mkdir(base, { recursive: true });
    await mkdir(join(base, "nodejs", "node_modules", "opencode-ai", "bin"), { recursive: true });
    await writeFile(
      join(base, "nodejs", "node_modules", "opencode-ai", "bin", "opencode.exe"),
      "fake",
    );
    delete process.env.OPENCODE_CLI;
    process.env.ProgramFiles = base;
    process.env.APPDATA = join(base, "appdata");
    expect(await opencodeProviders({})).toEqual([]);
    expect(await opencodeProviders({})).toEqual([]);

    await rm(join(base, "nodejs", "node_modules", "opencode-ai", "bin", "opencode.exe"), {
      force: true,
    });
    await mkdir(join(base, "appdata", "npm"), { recursive: true });
    await writeFile(join(base, "appdata", "npm", "opencode.cmd"), "@echo off\r\nexit /b 1\r\n");
    expect(await opencodeProviders({})).toEqual([]);
    await rm(join(base, "appdata", "npm", "opencode.cmd"), { force: true });
    expect(await opencodeProviders({})).toEqual([]);
    await rm(base, { recursive: true, force: true });
  });

  it("uses the non-Windows PATH resolver branch", async () => {
    const originalPlatform = process.platform;
    vi.resetModules();
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    try {
      delete process.env.OPENCODE_CLI;
      const { opencodeProviders: providers } = await import(
        "../src/drivers/opencode-cli/implementation.js"
      );
      await expect(providers({})).resolves.toEqual([]);
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    }
  });

  it("uses Windows fallback defaults when installation environment variables are absent", async () => {
    const originalPlatform = process.platform;
    vi.resetModules();
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    delete process.env.OPENCODE_CLI;
    delete process.env.ProgramFiles;
    delete process.env.APPDATA;
    try {
      const { opencodeProviders: providers } = await import(
        "../src/drivers/opencode-cli/implementation.js"
      );
      await expect(providers({})).resolves.toEqual([]);
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    }
  });
});
