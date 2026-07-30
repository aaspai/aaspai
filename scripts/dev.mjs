import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const yarn = process.platform === "win32" ? "yarn.cmd" : "yarn";
const env = { ...process.env, AASPAI_CWD: process.env.AASPAI_CWD || root };
const workspace = env.AASPAI_CWD;
const commands = [
  ["workspace", "@aaspai/api", "start", "start", "--cwd", workspace],
  ["workspace", "@aaspai/worker", "start", "start", "--cwd", workspace],
  ["workspace", "@aaspai/web", "dev"],
];

const children = commands.map((args) =>
  spawn(yarn, args, {
    cwd: root,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  }),
);

let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exit(code);
};

for (const child of children) child.once("exit", (code) => stop(code ?? 1));
process.once("SIGINT", () => stop());
process.once("SIGTERM", () => stop());
