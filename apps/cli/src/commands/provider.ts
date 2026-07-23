import { listAdapters } from "@aaspai/harness";
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
  return cmd;
}
