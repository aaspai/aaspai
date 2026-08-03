import assert from "node:assert/strict";
import test from "node:test";
import { configuredOpencodeProviders, filterOpencodeModels } from "./provider-status";

test("OpenCode auth exposes provider names without credential values", () => {
  const providers = configuredOpencodeProviders({
    anthropic: { type: "api", key: "must-not-leak" },
    empty: {},
    invalid: "must-not-leak-either",
  });
  assert.deepEqual(providers, ["anthropic"]);
  assert.doesNotMatch(JSON.stringify(providers), /must-not-leak/);
});

test("OpenCode models include built-ins and authenticated providers only", () => {
  assert.deepEqual(
    filterOpencodeModels(
      ["anthropic/claude-sonnet", "openai/gpt-5", "opencode/big-pickle", "opencode/free-model"],
      ["anthropic"],
    ),
    [
      { id: "opencode/big-pickle", label: "Big Pickle" },
      { id: "anthropic/claude-sonnet", label: "anthropic/claude-sonnet" },
      { id: "opencode/free-model", label: "opencode/free-model" },
    ],
  );
});
