import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { startDevelopmentGateway } from "./development-gateway.mjs";

const root = resolve(import.meta.dirname, "..");
try {
  loadEnvFile(join(root, ".env.local"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const yarn = process.platform === "win32" ? "yarn.cmd" : "yarn";
const gateway = await startDevelopmentGateway(root, process.env);
const env = { ...gateway.env, AASPAI_CWD: gateway.env.AASPAI_CWD || root };
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
const stop = async (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  await gateway.stop();
  process.exit(code);
};

for (const child of children) child.once("exit", (code) => void stop(code ?? 1));
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
