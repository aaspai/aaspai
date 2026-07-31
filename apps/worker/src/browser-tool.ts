export const BROWSER_SNAPSHOT_TOOL_SOURCE = `import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { tool } from "@opencode-ai/plugin";

export default tool({
  description: "Render one public HTTPS page in headless Chromium and return its DOM. Read-only research only.",
  args: {
    url: tool.schema.string().url().max(4096),
  },
  async execute({ url }) {
    const target = new URL(url);
    if (target.protocol !== "https:" || target.username || target.password) {
      throw new Error("browser_snapshot accepts public HTTPS URLs only");
    }
    const hostname = target.hostname.toLowerCase();
    if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
      throw new Error("browser_snapshot refuses local hosts");
    }
    const addresses = await lookup(hostname, { all: true });
    if (addresses.length === 0 || addresses.some(({ address }) => !publicAddress(address))) {
      throw new Error("browser_snapshot refuses private or unresolved hosts");
    }
    const process = Bun.spawn(
      [
        "chromium",
        "--headless",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        \`--host-resolver-rules=MAP \${hostname} \${addresses[0].address}, MAP * ~NOTFOUND\`,
        "--dump-dom",
        target.toString(),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const timeout = setTimeout(() => process.kill(), 30_000);
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]).finally(() => clearTimeout(timeout));
    if (exitCode !== 0) throw new Error(stderr.slice(0, 4096) || "Chromium render failed");
    return stdout.slice(0, 100_000);
  },
});

function publicAddress(address) {
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    return !(
      value === "::" ||
      value === "::1" ||
      value.startsWith("::ffff:") ||
      value.startsWith("fc") ||
      value.startsWith("fd") ||
      /^fe[89ab]/.test(value) ||
      value.startsWith("ff")
    );
  }
  const octets = address.split(".").map(Number);
  if (octets.length !== 4) return false;
  const [a, b] = octets;
  return !(
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}
`;
