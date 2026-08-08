import { getProductionAdapter, listProductionAdapters } from "@aaspai/harness";
import { defaultRuntimeRegistry } from "@aaspai/runtime";
import { Command } from "commander";

export function providerCommand(): Command {
  const cmd = new Command("provider").description("Provider capability operations");
  cmd
    .command("capabilities")
    .description("List harness and runtime capability truth")
    .option("--json", "print JSON")
    .action((options: { json?: boolean }) => {
      const data = {
        adapters: listProductionAdapters(),
        runtimes: defaultRuntimeRegistry().list(),
      };
      if (options.json) console.log(JSON.stringify(data, null, 2));
      else {
        for (const adapter of data.adapters) {
          console.log(
            `adapter ${adapter.type}: ${adapter.status} ${JSON.stringify(adapter.capabilities)}`,
          );
        }
        for (const { manifest: runtime } of data.runtimes) {
          console.log(
            `runtime ${runtime.type}: ${runtime.status} ${JSON.stringify(runtime.capabilities)}`,
          );
        }
      }
    });
  cmd
    .command("doctor")
    .description("Verify the OpenCode server environment")
    .option("--json", "print JSON")
    .action(async (options: { json?: boolean }) => {
      const cwd = process.cwd();
      const adapters = await Promise.all(
        listProductionAdapters().map(async (info) => {
          const environment = await getProductionAdapter("opencode_local").testEnvironment({
            config: {},
            cwd,
          });
          return {
            type: info.type,
            label: info.label,
            installed: true,
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
      console.log("Configure the OpenCode server endpoint or run the managed local server again.");
    });
  return cmd;
}
