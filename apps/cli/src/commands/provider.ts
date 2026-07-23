import { getAdapter, listAdapters } from "@aaspai/harness";
import { listRuntimeTargets } from "@aaspai/runtime";
import { Command } from "commander";

export function providerCommand(): Command {
  const cmd = new Command("provider").description("Provider capability operations");
  cmd
    .command("capabilities")
    .description("List harness and runtime capability truth")
    .option("--json", "print JSON")
    .action((options: { json?: boolean }) => {
      const data = { adapters: listAdapters(), runtimes: listRuntimeTargets() };
      if (options.json) console.log(JSON.stringify(data, null, 2));
      else {
        for (const adapter of data.adapters) {
          console.log(
            `adapter ${adapter.type}: ${adapter.status} ${JSON.stringify(adapter.capabilities)}`,
          );
        }
        for (const runtime of data.runtimes) {
          console.log(
            `runtime ${runtime.kind}${runtime.provider ? `:${runtime.provider}` : ""}: ${runtime.status} ${JSON.stringify(runtime.capabilities)}`,
          );
        }
      }
    });
  cmd
    .command("doctor")
    .description("Verify locally installed agent CLIs")
    .option("--json", "print JSON")
    .action(async (options: { json?: boolean }) => {
      const cwd = process.cwd();
      const adapters = await Promise.all(
        (["codex_local", "claude_local", "opencode_cli"] as const).map(async (type) => {
          const info = listAdapters().find((adapter) => adapter.type === type);
          const environment = await getAdapter(type).testEnvironment({ config: {}, cwd });
          const installed = !environment.checks.some(
            (check) => check.name.endsWith("_cli") && /not found|enoent/i.test(check.message),
          );
          return {
            type,
            label: info?.label ?? type,
            installed,
            ready: environment.ok,
            environment,
          };
        }),
      );
      if (options.json) {
        console.log(JSON.stringify({ adapters }, null, 2));
        return;
      }
      for (const adapter of adapters) {
        const marker = adapter.ready ? "✓" : adapter.installed ? "!" : "✗";
        console.log(
          `${marker} ${adapter.label}: ${adapter.ready ? "ready" : adapter.installed ? "needs attention" : "not installed"}`,
        );
        for (const check of adapter.environment.checks) console.log(`  ${check.message}`);
      }
      console.log("");
      console.log("Install or authenticate any missing CLI, then run this command again.");
    });
  return cmd;
}
