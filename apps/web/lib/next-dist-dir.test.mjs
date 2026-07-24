import assert from "node:assert/strict";
import test from "node:test";

import { nextDevTsconfig, nextDistDir } from "./next-dist-dir.mjs";

test("isolates concurrent dev servers by their effective port", () => {
  assert.equal(
    nextDistDir({
      argv: ["node", "next", "dev", "--port", "3000", "-p", "3002"],
      configured: "",
      nodeEnv: "development",
    }),
    ".next-dev-3002",
  );
  assert.equal(
    nextDistDir({
      argv: ["node", "start-server.js"],
      configured: "",
      nodeEnv: "development",
      port: "3002",
    }),
    ".next-dev-3002",
  );
});

test("preserves explicit and production build directories", () => {
  assert.equal(
    nextDistDir({
      argv: ["node", "next", "dev", "-p3003"],
      configured: "custom-next",
      nodeEnv: "development",
    }),
    "custom-next",
  );
  assert.equal(
    nextDistDir({
      argv: ["node", "next", "build"],
      configured: "",
      nodeEnv: "production",
    }),
    ".next",
  );
});

test("keeps Next's generated type include out of the tracked tsconfig", () => {
  const config = nextDevTsconfig(".next-dev-3002");

  assert.equal(config?.path, ".next-dev-3002.tsconfig.json");
  assert.deepEqual(JSON.parse(config?.contents ?? ""), {
    extends: "./tsconfig.json",
    compilerOptions: {
      plugins: [{ name: "next" }],
    },
    include: [
      "next-env.d.ts",
      "app/**/*.ts",
      "app/**/*.tsx",
      "components/**/*.ts",
      "components/**/*.tsx",
      "lib/**/*.ts",
      "lib/**/*.tsx",
      ".next-dev-3002/types/**/*.ts",
    ],
    exclude: ["node_modules", ".next", "dist", "public/templates/files"],
  });
  assert.equal(nextDevTsconfig(".next"), undefined);
});
