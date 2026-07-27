import { readFileSync } from "node:fs";
import { Daytona } from "@daytonaio/sdk";

const daytona = new Daytona({ apiKey: process.env.DAYTONA_API_KEY! });

console.log("Creating sandbox...");
const sandbox = await daytona.create({ image: "node:22-bookworm-slim" }, { timeout: 120 });
console.log("Sandbox:", sandbox.id);

try {
  // Bootstrap: install opencode + upload auth
  console.log("Bootstrapping...");
  await sandbox.process.executeCommand(
    "npm install -g opencode-ai 2>&1 | tail -3",
    "/",
    { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/root" },
    240,
  );
  const auth = readFileSync(process.env.AASPAI_HOST_AUTH_PATH!, "utf8");
  await sandbox.fs.uploadFile(Buffer.from(auth, "utf8"), "/root/.local/share/opencode/auth.json");

  console.log("\nTest 1: opencode with env passed via executeCommand");
  const r1 = await sandbox.process.executeCommand(
    "opencode --version",
    "/",
    {
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: "/root",
      LANG: "C.UTF-8",
    },
    30,
  );
  console.log("exit:", r1.exitCode, "out:", r1.result);

  console.log("\nTest 2: opencode with env inlined in the command");
  const r2 = await sandbox.process.executeCommand(
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C.UTF-8 opencode --version",
    "/",
    undefined,
    30,
  );
  console.log("exit:", r2.exitCode, "out:", r2.result);
} finally {
  await sandbox.delete(60);
}
