import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { ExecutionTarget } from "@aaspai/contracts/runtime";
import { Daytona } from "@daytonaio/sdk";
import { resolveTarget } from "../../src/registry.js";

const repoRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}`;
const root = join(repoRoot, "workspace", "layer-02-execution", "daytona", runId);
const apiKey = process.env.DAYTONA_API_KEY ?? "";
const target: ExecutionTarget = {
  kind: "sandbox",
  provider: "daytona",
  remoteCwd: "/workspace",
  timeoutMs: 120_000,
};

await mkdir(join(root, "raw"), { recursive: true });
await mkdir(join(root, "artifacts"), { recursive: true });
await writeFile(
  join(root, "commands.txt"),
  "daytonaTarget.run(node -e real-boundary-probe)\n",
  "utf8",
);
await writeFile(
  join(root, "config-snapshot.json"),
  JSON.stringify({ target, apiKeyConfigured: apiKey.length > 0 }, null, 2),
  "utf8",
);
await writeFile(
  join(root, "environment-snapshot.json"),
  JSON.stringify(
    {
      provider: "daytona",
      sdk: "@daytonaio/sdk",
      apiKeyConfigured: apiKey.length > 0,
      apiUrlConfigured: Boolean(process.env.DAYTONA_API_URL),
    },
    null,
    2,
  ),
  "utf8",
);

const redact = (value: string): string =>
  apiKey.length > 0 ? value.split(apiKey).join("[REDACTED]") : value;
const startedAt = new Date().toISOString();
try {
  const result = await resolveTarget(target).run(target, {
    command: "node",
    args: [
      "-e",
      "require('node:fs').writeFileSync('daytona-marker.txt', process.cwd()); console.log(JSON.stringify({cwd:process.cwd(), runtime:'daytona'}));",
    ],
    cwd: root,
    env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/root" },
    timeoutMs: 120_000,
  });
  if (
    result.exitCode !== 0 ||
    !result.stdout.includes('"runtime":"daytona"') ||
    result.runtimeIdentity?.kind !== "sandbox" ||
    !result.runtimeIdentity.connectionIdentity?.startsWith("daytona:")
  ) {
    throw new Error(`Daytona boundary assertion failed: ${JSON.stringify(result)}`);
  }
  await writeFile(join(root, "raw", "result.json"), JSON.stringify(result, null, 2), "utf8");
  const leaseId = result.runtimeIdentity.connectionIdentity?.slice("daytona:".length);
  const daytona = new Daytona({
    apiKey,
    ...(process.env.DAYTONA_API_URL ? { apiUrl: process.env.DAYTONA_API_URL } : {}),
  });
  let listedSandboxes = 0;
  let matchingLease = true;
  for (let attempt = 1; attempt <= 10 && matchingLease; attempt += 1) {
    const listed = await daytona.list(undefined, 1, 100);
    listedSandboxes = listed.items.length;
    matchingLease = listed.items.some((sandbox) => sandbox.id === leaseId);
    if (matchingLease) await delay(3_000);
  }
  const cleanup = {
    listedSandboxes,
    matchingLease,
    verifiedAt: new Date().toISOString(),
  };
  await writeFile(join(root, "evidence-cleanup.json"), JSON.stringify(cleanup, null, 2), "utf8");
  if (cleanup.matchingLease) throw new Error(`Daytona lease was not released: ${leaseId}`);
  await writeFile(
    join(root, "RESULT.md"),
    `# Daytona real execution evidence\n\nStatus: passed\n\nRuntime identity: ${JSON.stringify(result.runtimeIdentity)}\n\nCleanup: verified (${listedSandboxes} sandboxes listed; lease absent)\n\nStarted: ${startedAt}\n`,
    "utf8",
  );
  console.log(JSON.stringify({ runId, root, status: result.exitCode === 0 ? "passed" : "failed" }));
  process.exitCode = result.exitCode === 0 ? 0 : 1;
} catch (error) {
  const message = redact(error instanceof Error ? error.message : String(error));
  const evidence = {
    runId,
    root,
    status: "failed",
    errorName: error instanceof Error ? error.name : "UnknownError",
    error: message,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  await writeFile(join(root, "raw", "error.json"), JSON.stringify(evidence, null, 2), "utf8");
  await writeFile(
    join(root, "RESULT.md"),
    `# Daytona real execution evidence\n\nStatus: failed\n\nError: ${evidence.errorName}: ${message}\n\nNo credential was persisted.\n`,
    "utf8",
  );
  console.error(
    JSON.stringify({
      runId,
      root,
      status: "failed",
      errorName: evidence.errorName,
      error: message,
    }),
  );
  process.exitCode = 1;
}
