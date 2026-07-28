import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENTS_DIR,
  DEFAULT_CONFIG_PATH,
  DEFAULT_JSON_CONFIG_PATH,
  DEFAULT_KNOWLEDGE_DIR,
  DEFAULT_LOOPS_DIR,
} from "../src/index.js";

describe("workspace paths", () => {
  it("keeps generated definitions and config under .aaspai", () => {
    expect([
      DEFAULT_AGENTS_DIR,
      DEFAULT_KNOWLEDGE_DIR,
      DEFAULT_LOOPS_DIR,
      DEFAULT_CONFIG_PATH,
      DEFAULT_JSON_CONFIG_PATH,
    ]).toEqual([
      ".aaspai/agents",
      ".aaspai/knowledge",
      ".aaspai/loops",
      ".aaspai/aaspai.config.ts",
      ".aaspai/aaspai.config.json",
    ]);
  });
});
