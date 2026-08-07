import assert from "node:assert/strict";
import test from "node:test";
import { chatRuntimeSchema, resolveChatRuntime } from "./chat-runtime";

test("T1: no runtime body + no agent default resolves to local", () => {
  const result = resolveChatRuntime(undefined, undefined);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.runtime.kind, "local");
  }
});

test("T1: no runtime body + agent without runtime.default resolves to local", () => {
  const result = resolveChatRuntime(undefined, { env: "staging" });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.runtime.kind, "local");
  }
});

test("T2: body sandbox:daytona override wins over agent default", () => {
  const result = resolveChatRuntime(
    { kind: "sandbox", provider: "daytona", remoteCwd: "/workspace" },
    { default: { kind: "local" } },
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.runtime.kind, "sandbox");
    assert.equal((result.runtime as { provider?: string }).provider, "daytona");
    assert.equal((result.runtime as { remoteCwd?: string }).remoteCwd, "/workspace");
  }
});

test("T2: body sandbox:daytona without remoteCwd defaults to /workspace", () => {
  const result = resolveChatRuntime({ kind: "sandbox", provider: "daytona" }, undefined);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.runtime.kind, "sandbox");
    assert.equal((result.runtime as { remoteCwd?: string }).remoteCwd, "/workspace");
  }
});

test("T2: agent default sandbox:daytona is used when body omits runtime", () => {
  const result = resolveChatRuntime(undefined, {
    default: { kind: "sandbox", provider: "daytona", remoteCwd: "/workspace" },
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.runtime.kind, "sandbox");
    assert.equal((result.runtime as { provider?: string }).provider, "daytona");
  }
});

test("T3: body with unknown provider is rejected", () => {
  const result = resolveChatRuntime({ kind: "sandbox", provider: "nope" }, undefined);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /runtime/i);
});

test("T3: body with unknown kind is rejected", () => {
  const result = resolveChatRuntime({ kind: "quantum" }, undefined);
  assert.equal(result.ok, false);
});

test("chatRuntimeSchema rejects unknown provider", () => {
  assert.equal(chatRuntimeSchema.safeParse({ kind: "sandbox", provider: "nope" }).success, false);
  assert.equal(chatRuntimeSchema.safeParse({ kind: "sandbox", provider: "daytona" }).success, true);
  assert.equal(chatRuntimeSchema.safeParse({ kind: "local" }).success, true);
  assert.equal(chatRuntimeSchema.safeParse({ kind: "docker" }).success, false);
});

test("invalid agent default degrades to local instead of 400", () => {
  const result = resolveChatRuntime(undefined, {
    default: { kind: "sandbox", provider: "nope" },
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.runtime.kind, "local");
  }
});
