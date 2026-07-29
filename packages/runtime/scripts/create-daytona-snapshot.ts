import { Daytona, Image } from "@daytonaio/sdk";

const name = process.env.DAYTONA_SNAPSHOT?.trim() || "aaspai-opencode-1-18-5-v1";
const client = new Daytona();
const existing = (await client.snapshot.list(1, 100)).items.find((item) => item.name === name);

if (existing) {
  console.log(JSON.stringify({ name, id: existing.id, state: existing.state, reused: true }));
} else {
  const image = Image.base("node:22-bookworm-slim")
    .runCommands(
      "apt-get update -qq && apt-get install -y -qq git ca-certificates && rm -rf /var/lib/apt/lists/*",
      "npm install -g opencode-ai@1.18.5",
      "git --version && opencode --version",
    )
    .env({
      HOME: "/root",
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      LANG: "C.UTF-8",
    });
  const created = await client.snapshot.create(
    { name, image },
    { timeout: 900, onLogs: (chunk) => process.stdout.write(chunk) },
  );
  const active =
    String(created.state).toLowerCase() === "active"
      ? created
      : await client.snapshot.activate(created);
  console.log(JSON.stringify({ name, id: active.id, state: active.state, reused: false }));
}
