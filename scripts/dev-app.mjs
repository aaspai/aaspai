import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";

// Run a single app's dev server with the workspace root pinned as
// AASPAI_CWD (so .aaspai/*, the shared state.db, and repo-root .env.local
// resolve identically to `yarn dev`).
//
//   usage: node scripts/dev-app.mjs <api|worker|web>
//
// This is the per-package entrypoint invoked by `turbo run dev` (and by
// each app's `dev` script standalone). turbo.json marks `dev` persistent,
// so all three run concurrently and stream logs into one TUI.

const app = process.argv[2];
if (!["api", "worker", "web"].includes(app ?? "")) {
  console.error(`usage: node scripts/dev-app.mjs <api|worker|web>`);
  process.exit(1);
}

const root = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const env = { ...process.env, AASPAI_CWD: process.env.AASPAI_CWD || root };

const tsxCli = require.resolve("tsx/cli");
const nextBin = require.resolve("next/dist/bin/next");

const plans = {
  api: {
    cwd: resolve(root, "apps/api"),
    file: process.execPath,
    args: [tsxCli, "watch", "./src/main.ts", "start", "--cwd", root],
  },
  worker: {
    cwd: resolve(root, "apps/worker"),
    file: process.execPath,
    args: [tsxCli, "watch", "./src/main.ts", "start", "--cwd", root],
  },
  web: {
    cwd: resolve(root, "apps/web"),
    file: process.execPath,
    args: [nextBin, "dev", "--port", "3000"],
  },
};

const plan = plans[app];
const child = spawn(plan.file, plan.args, {
  cwd: plan.cwd,
  env,
  stdio: "inherit",
});

let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  child.kill();
  process.exit(code);
};

child.once("exit", (code) => stop(code ?? 1));
child.once("error", (err) => {
  console.error(err);
  stop(1);
});
process.once("SIGINT", () => stop());
process.once("SIGTERM", () => stop());
