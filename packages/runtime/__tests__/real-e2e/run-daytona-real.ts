import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  timeoutMs: 240_000,
};

await mkdir(join(root, "raw"), { recursive: true });
await mkdir(join(root, "artifacts"), { recursive: true });
await writeFile(join(root, "input.txt"), "host-seed\n", "utf8");
await writeFile(join(root, "delete-me.txt"), "remove remotely\n", "utf8");
await writeFile(
  join(root, "commands.txt"),
  [
    "daytonaTarget.run(node -e workspace-roundtrip-probe)",
    "daytonaTarget.run(node -e cancellation-probe)",
    "daytonaTarget.run(node -e timeout-probe)",
    "daytonaTarget.run(opencode run + --session resume) # when AASPAI_HOST_AUTH_PATH is set",
    "",
  ].join("\n"),
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
      hostAuthConfigured: Boolean(process.env.AASPAI_HOST_AUTH_PATH),
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
  const streamed: string[] = [];
  const result = await resolveTarget(target).run(target, {
    command: "node",
    args: [
      "-e",
      "const fs=require('node:fs'); const stdin=fs.readFileSync(0,'utf8'); const seed=fs.readFileSync('input.txt','utf8'); fs.writeFileSync('input.txt',seed+'remote\\n'); fs.unlinkSync('delete-me.txt'); fs.writeFileSync('binary.bin',Buffer.from([0,255,1,254])); fs.writeFileSync('daytona-marker.json',JSON.stringify({cwd:process.cwd(),stdin,seed})); console.log(JSON.stringify({cwd:process.cwd(),runtime:'daytona',stdin}));",
    ],
    cwd: root,
    stdin: "stdin-ok\n",
    env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/root" },
    timeoutMs: 240_000,
    onLog: (stream, chunk) => {
      streamed.push(`${stream}:${chunk}`);
    },
  });
  if (
    result.exitCode !== 0 ||
    !result.stdout.includes('"runtime":"daytona"') ||
    result.runtimeIdentity?.kind !== "sandbox" ||
    !result.runtimeIdentity.connectionIdentity?.startsWith("daytona:")
  ) {
    throw new Error(`Daytona boundary assertion failed: ${JSON.stringify(result)}`);
  }
  if (!streamed.join("").includes('"runtime":"daytona"')) {
    throw new Error(`Daytona streaming assertion failed: ${JSON.stringify(streamed)}`);
  }
  const marker = JSON.parse(await readFile(join(root, "daytona-marker.json"), "utf8")) as {
    cwd: string;
    stdin: string;
    seed: string;
  };
  const restoredInput = await readFile(join(root, "input.txt"), "utf8");
  const restoredBinary = await readFile(join(root, "binary.bin"));
  if (
    marker.cwd !== result.runtimeIdentity.remoteCwd ||
    marker.stdin !== "stdin-ok\n" ||
    marker.seed !== "host-seed\n" ||
    restoredInput !== "host-seed\nremote\n" ||
    !restoredBinary.equals(Buffer.from([0, 255, 1, 254]))
  ) {
    throw new Error(`Daytona workspace restore assertion failed: ${JSON.stringify(marker)}`);
  }
  try {
    await readFile(join(root, "delete-me.txt"));
    throw new Error("Daytona workspace deletion was not restored");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(join(root, "raw", "result.json"), JSON.stringify(result, null, 2), "utf8");
  const leaseIds = [result.runtimeIdentity.connectionIdentity.slice("daytona:".length)];

  const controller = new AbortController();
  const cancellationLogs: string[] = [];
  const cancelled = await resolveTarget(target).run(target, {
    command: "node",
    args: ["-e", "console.log('cancel-ready'); setInterval(() => {}, 1000)"],
    cwd: root,
    signal: controller.signal,
    timeoutMs: 30_000,
    onLog: (_stream, chunk) => {
      cancellationLogs.push(chunk);
      if (chunk.includes("cancel-ready")) controller.abort();
    },
  });
  if (
    cancelled.exitCode !== null ||
    cancelled.signal !== "SIGTERM" ||
    cancelled.timedOut ||
    !cancellationLogs.join("").includes("cancel-ready")
  ) {
    throw new Error(`Daytona cancellation assertion failed: ${JSON.stringify(cancelled)}`);
  }
  leaseIds.push(cancelled.runtimeIdentity?.connectionIdentity?.slice("daytona:".length) ?? "");
  await writeFile(
    join(root, "raw", "cancellation-result.json"),
    JSON.stringify(cancelled, null, 2),
    "utf8",
  );

  const timedOut = await resolveTarget(target).run(target, {
    command: "node",
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: root,
    timeoutMs: 1_000,
  });
  if (timedOut.exitCode !== null || timedOut.signal !== "SIGTERM" || !timedOut.timedOut) {
    throw new Error(`Daytona timeout assertion failed: ${JSON.stringify(timedOut)}`);
  }
  leaseIds.push(timedOut.runtimeIdentity?.connectionIdentity?.slice("daytona:".length) ?? "");
  await writeFile(
    join(root, "raw", "timeout-result.json"),
    JSON.stringify(timedOut, null, 2),
    "utf8",
  );

  let agentStatus = "skipped (AASPAI_HOST_AUTH_PATH not set)";
  if (process.env.AASPAI_HOST_AUTH_PATH) {
    const resumableTarget: ExecutionTarget = {
      ...target,
      metadata: { reuseLease: true },
    };
    const firstAgentResult = await resolveTarget(resumableTarget).run(resumableTarget, {
      command: "opencode",
      args: [
        "run",
        "--format",
        "json",
        "--model",
        process.env.AASPAI_OPENCODE_MODEL ?? "opencode-go/mimo-v2.5",
        "--title",
        `daytona-agent-e2e/${runId}`,
        "Use your tools to create resume-first.txt containing exactly FIRST followed by a newline. Do not only explain; make the file.",
      ],
      cwd: root,
      timeoutMs: 180_000,
    });
    const leaseId =
      firstAgentResult.runtimeIdentity?.connectionIdentity?.slice("daytona:".length) ?? "";
    leaseIds.push(leaseId);
    const sessionId = firstAgentResult.stdout.split(/\r?\n/).flatMap((line) => {
      try {
        const value = JSON.parse(line) as { sessionID?: string; sessionId?: string };
        return [value.sessionID ?? value.sessionId].filter((entry): entry is string =>
          Boolean(entry),
        );
      } catch {
        return [];
      }
    })[0];
    const resumedTarget: ExecutionTarget = {
      ...target,
      metadata: {
        providerLeaseId: leaseId,
        providerLeaseRemoteCwd: firstAgentResult.runtimeIdentity?.remoteCwd ?? "/aaspai-workspace",
      },
    };
    const resumedAgentResult = await resolveTarget(resumedTarget).run(resumedTarget, {
      command: "opencode",
      args: [
        "run",
        "--format",
        "json",
        "--model",
        process.env.AASPAI_OPENCODE_MODEL ?? "opencode-go/mimo-v2.5",
        "--session",
        sessionId ?? "missing-session",
        "Read resume-first.txt, then create resume-second.txt containing exactly SECOND followed by a newline.",
      ],
      cwd: root,
      timeoutMs: 180_000,
    });
    await writeFile(
      join(root, "raw", "agent-resume-result.json"),
      JSON.stringify({ firstAgentResult, resumedAgentResult, sessionId }, null, 2),
      "utf8",
    );
    if (
      firstAgentResult.exitCode !== 0 ||
      resumedAgentResult.exitCode !== 0 ||
      !sessionId ||
      resumedAgentResult.runtimeIdentity?.connectionIdentity !==
        firstAgentResult.runtimeIdentity?.connectionIdentity
    ) {
      throw new Error(
        `Daytona agent resume assertion failed: ${JSON.stringify({ firstAgentResult, resumedAgentResult, sessionId })}`,
      );
    }
    const firstOutput = await readFile(join(root, "resume-first.txt"), "utf8");
    const secondOutput = await readFile(join(root, "resume-second.txt"), "utf8");
    if (firstOutput !== "FIRST\n" || secondOutput !== "SECOND\n") {
      throw new Error(
        `Daytona resumed agent output assertion failed: ${JSON.stringify({ firstOutput, secondOutput })}`,
      );
    }
    agentStatus = "passed (same Daytona lease + same OpenCode session)";
  }

  const daytona = new Daytona({
    apiKey,
    ...(process.env.DAYTONA_API_URL ? { apiUrl: process.env.DAYTONA_API_URL } : {}),
  });
  let listedSandboxes = 0;
  let matchingLeaseIds = leaseIds;
  for (let attempt = 1; attempt <= 10 && matchingLeaseIds.length > 0; attempt += 1) {
    const listed = await daytona.list(undefined, 1, 100);
    listedSandboxes = listed.items.length;
    matchingLeaseIds = leaseIds.filter((id) => listed.items.some((sandbox) => sandbox.id === id));
    if (matchingLeaseIds.length > 0) await delay(3_000);
  }
  const cleanup = {
    listedSandboxes,
    matchingLeaseIds,
    verifiedAt: new Date().toISOString(),
  };
  await writeFile(join(root, "evidence-cleanup.json"), JSON.stringify(cleanup, null, 2), "utf8");
  if (cleanup.matchingLeaseIds.length > 0) {
    throw new Error(`Daytona leases were not released: ${cleanup.matchingLeaseIds.join(", ")}`);
  }
  await writeFile(
    join(root, "RESULT.md"),
    `# Daytona real execution evidence\n\nStatus: passed\n\nWorkspace, stdin, streaming, cancellation, timeout, binary restore, deletion restore: passed\n\nAgent CLI + resume: ${agentStatus}\n\nRuntime identity: ${JSON.stringify(result.runtimeIdentity)}\n\nCleanup: verified (${listedSandboxes} sandboxes listed; ${leaseIds.length} test leases absent)\n\nStarted: ${startedAt}\n`,
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
