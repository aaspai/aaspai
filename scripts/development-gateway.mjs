import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { Daytona } from "@daytonaio/sdk";

export async function startDevelopmentGateway(root, inputEnv) {
  if (
    inputEnv.AASPAI_GATEWAY_CONTROL_URL &&
    inputEnv.AASPAI_GATEWAY_CONTROL_TOKEN &&
    inputEnv.AASPAI_GATEWAY_AGENT_BASE_URL
  ) {
    return { env: inputEnv, stop: async () => undefined };
  }
  const upstreamKey = inputEnv.OPENROUTER_API_KEY?.trim();
  if (!upstreamKey) {
    console.warn("[gateway] OPENROUTER_API_KEY is not configured; real company launch is disabled");
    return { env: inputEnv, stop: async () => undefined };
  }

  const controlToken = randomBytes(32).toString("hex");
  if (!inputEnv.DAYTONA_API_KEY) {
    return await startLocalGateway(root, inputEnv, upstreamKey, controlToken);
  }

  console.log("[gateway] starting isolated development gateway...");
  const daytona = new Daytona({ apiKey: inputEnv.DAYTONA_API_KEY });
  const sandbox = await daytona.create(
    {
      image: "node:22-bookworm-slim",
      ephemeral: true,
      public: true,
      labels: { "aaspai-role": "development-attempt-gateway" },
    },
    { timeout: 180 },
  );
  try {
    const script = join(root, "scripts", "attempt-gateway.mjs");
    await sandbox.fs.uploadFile(script, "/tmp/aaspai-attempt-gateway.mjs");
    const launch = await sandbox.process.executeCommand(
      [
        `GATEWAY_CONTROL_TOKEN=${quote(controlToken)}`,
        `OPENROUTER_API_KEY=${quote(upstreamKey)}`,
        "nohup node /tmp/aaspai-attempt-gateway.mjs",
        ">/tmp/aaspai-attempt-gateway.log 2>&1 </dev/null &",
      ].join(" "),
      "/",
      undefined,
      30,
    );
    if (launch.exitCode !== 0) throw new Error("development gateway failed to start");
    const preview = await sandbox.getPreviewLink(8787);
    const url = preview.url.replace(/\/+$/, "");
    await waitForHealth(url, controlToken);
    console.log("[gateway] isolated attempt gateway is ready");
    return {
      env: {
        ...inputEnv,
        AASPAI_GATEWAY_CONTROL_URL: url,
        AASPAI_GATEWAY_CONTROL_TOKEN: controlToken,
        AASPAI_GATEWAY_AGENT_BASE_URL: `${url}/v1`,
      },
      stop: async () => {
        await sandbox.delete(120).catch(() => undefined);
      },
    };
  } catch (error) {
    await sandbox.delete(120).catch(() => undefined);
    throw error;
  }
}

async function startLocalGateway(root, inputEnv, upstreamKey, controlToken) {
  console.log("[gateway] starting local Docker development gateway...");
  const port = 18_787;
  const child = spawn(process.execPath, [join(root, "scripts", "attempt-gateway.mjs")], {
    cwd: root,
    env: {
      PATH: inputEnv.PATH,
      SystemRoot: inputEnv.SystemRoot,
      GATEWAY_CONTROL_TOKEN: controlToken,
      OPENROUTER_API_KEY: upstreamKey,
      GATEWAY_PORT: String(port),
    },
    stdio: "inherit",
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(controlUrl, controlToken);
    return {
      env: {
        ...inputEnv,
        AASPAI_GATEWAY_CONTROL_URL: controlUrl,
        AASPAI_GATEWAY_CONTROL_TOKEN: controlToken,
        AASPAI_GATEWAY_AGENT_BASE_URL: `http://host.docker.internal:${port}/v1`,
      },
      stop: async () => {
        child.kill();
      },
    };
  } catch (error) {
    child.kill();
    throw error;
  }
}

async function waitForHealth(url, controlToken) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const headers = {
      authorization: `Bearer ${controlToken}`,
      "x-daytona-skip-preview-warning": "true",
    };
    const [healthy, controlled] = await Promise.all([
      fetch(`${url}/health`, { headers }).then((response) => response.ok),
      fetch(`${url}/audit`, { headers }).then((response) => response.ok),
    ]).catch(() => [false, false]);
    if (healthy && controlled) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("development attempt gateway did not become healthy");
}

function quote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
