import { resolve } from "node:path";
import { getDefaultDb, runMigrations } from "@aaspai/db";
import {
  backfillFromControlPlane,
  defaultLiveHub,
  exportTelemetry,
  IMPORT_SOURCES,
  type ImportSource,
  importProviderFile,
  parserFor,
  TelemetryRepository,
  TelemetryWatcher,
} from "@aaspai/telemetry";
import { Command } from "commander";
import pc from "picocolors";
import { table } from "./_shared.js";

function repoFor(_organizationId: string): TelemetryRepository {
  const handle = getDefaultDb();
  runMigrations(handle);
  return new TelemetryRepository(handle);
}

function organizationId(): string {
  return process.env.AASPAI_ORGANIZATION_ID ?? "org_local";
}

export function observeCommand(): Command {
  const cmd = new Command("observe").description(
    "Observer: query, import, watch, export, delete telemetry",
  );

  cmd
    .command("overview")
    .description("Show observer overview (stats, services, ingestion health)")
    .action(() => {
      const org = organizationId();
      const repo = repoFor(org);
      const stats = repo.getStats(org);
      const services = repo.getServices(org);
      const ingestErrors = repo.queryIngestErrors({ organizationId: org, limit: 5 });
      const imports = repo.listImportState(org);
      console.log(pc.cyan("Observer overview"));
      console.log(
        table([
          ["organization", org],
          ["logs", String(stats.logs)],
          ["spans", String(stats.spans)],
          ["traces", String(stats.traces)],
          ["metrics", String(stats.metrics)],
          ["sessions", String(stats.sessions)],
          ["error rate", `${stats.errorRate}%`],
          ["services", services.join(", ") || "-"],
          ["import files", String(imports.length)],
          ["ingestion errors", String(ingestErrors.total ?? ingestErrors.rows.length)],
        ]),
      );
      if (ingestErrors.rows.length > 0) {
        console.log(pc.yellow("\nRecent ingestion errors:"));
        for (const e of ingestErrors.rows.slice(0, 5)) {
          console.log(`  ${pc.red(String(e.kind))} ${pc.gray(String(e.message))}`);
        }
      }
      process.exit(0);
    });

  cmd
    .command("logs")
    .description("List recent logs")
    .option("--search <text>", "search text")
    .option("--provider <name>", "provider filter")
    .option("--session <id>", "session id filter")
    .option("--limit <n>", "max rows", "20")
    .action(
      async (opts: { search?: string; provider?: string; session?: string; limit: string }) => {
        const org = organizationId();
        const repo = repoFor(org);
        const result = repo.queryLogs({
          organizationId: org,
          search: opts.search,
          provider: opts.provider,
          sessionId: opts.session,
          limit: Math.min(Number(opts.limit) || 20, 200),
        });
        console.log(pc.cyan(`Logs (${result.rows.length})`));
        for (const row of result.rows) {
          const time = String(row.observedAt ?? "").slice(0, 19);
          console.log(
            `  ${pc.gray(time)} ${pc.green(String(row.provider)).padEnd(12)} ${String(row.body ?? "").slice(0, 120)}`,
          );
        }
        process.exit(0);
      },
    );

  cmd
    .command("import <source>")
    .description(`Import provider session files (${IMPORT_SOURCES.join(", ")})`)
    .option("--file <path>", "import a single file")
    .option("--dry-run", "count without writing")
    .option("--force", "re-import already-imported files")
    .action(async (source: string, opts: { file?: string; dryRun?: boolean; force?: boolean }) => {
      const src = source as ImportSource;
      if (!IMPORT_SOURCES.includes(src)) {
        console.error(pc.red(`unknown source: ${source} (valid: ${IMPORT_SOURCES.join(", ")})`));
        process.exit(1);
      }
      const org = organizationId();
      const repo = repoFor(org);
      const parser = parserFor(src, { organizationId: org });
      const files = opts.file ? [opts.file] : await parser.findSessionFiles();
      console.log(pc.cyan(`Importing ${src} — ${files.length} file(s)`));
      let logs = 0;
      let metrics = 0;
      let spans = 0;
      let imported = 0;
      let errors = 0;
      for (const filePath of files) {
        try {
          const result = await importProviderFile(repo, defaultLiveHub, parser, {
            organizationId: org,
            source: src,
            filePath,
            dryRun: opts.dryRun,
            force: opts.force,
          });
          if (result.status === "current") {
            console.log(`  ${pc.gray("skipped")} ${filePath}`);
          } else {
            console.log(`  ${pc.green(`imported ${result.recordCount} records`)} ${filePath}`);
            logs += result.logs;
            metrics += result.metrics;
            spans += result.spans;
            imported += 1;
          }
        } catch (err) {
          errors += 1;
          console.error(
            `  ${pc.red("failed")} ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      console.log(
        pc.cyan(
          `\nDone: ${imported} file(s), ${logs} logs, ${metrics} metrics, ${spans} spans, ${errors} error(s)`,
        ),
      );
      process.exit(errors > 0 ? 1 : 0);
    });

  cmd
    .command("watch")
    .description("Watch provider log directories for new session files")
    .option("--backfill", "import existing files at startup")
    .action(async (opts: { backfill?: boolean }) => {
      const org = organizationId();
      const repo = repoFor(org);
      const watcher = new TelemetryWatcher(repo, defaultLiveHub, {
        organizationId: org,
        backfill: opts.backfill,
        envPaths: {
          claude: process.env.AI_OBSERVER_CLAUDE_PATH,
          codex: process.env.AI_OBSERVER_CODEX_PATH,
          gemini: process.env.AI_OBSERVER_GEMINI_PATH,
        },
      });
      await watcher.start();
      console.log(pc.cyan("Watching provider session directories (Ctrl+C to stop)"));
      const printHealth = () => {
        const h = watcher.healthSnapshot();
        console.log(`${pc.gray(JSON.stringify(h))}`);
      };
      const timer = setInterval(printHealth, 10_000);
      printHealth();
      const shutdown = async () => {
        clearInterval(timer);
        await watcher.stop();
        process.exit(0);
      };
      process.once("SIGINT", () => void shutdown());
      process.once("SIGTERM", () => void shutdown());
      await new Promise(() => {});
    });

  cmd
    .command("export")
    .description("Export telemetry to .aaspai/telemetry-exports")
    .option("--from <iso>", "start time")
    .option("--to <iso>", "end time")
    .option("--sessions", "include session projections")
    .option("--dashboards", "include dashboards")
    .option("--zip", "create a ZIP bundle")
    .action(
      async (opts: {
        from?: string;
        to?: string;
        sessions?: boolean;
        dashboards?: boolean;
        zip?: boolean;
      }) => {
        const org = organizationId();
        const repo = repoFor(org);
        const outputDir = resolve(process.cwd(), ".aaspai", "telemetry-exports");
        const summary = await exportTelemetry(repo, {
          organizationId: org,
          outputDir,
          from: opts.from,
          to: opts.to,
          includeSessions: opts.sessions,
          includeDashboards: opts.dashboards,
          createZip: opts.zip,
        });
        console.log(
          pc.cyan(
            `Export complete (${summary.files.length} file(s), manifest: ${summary.manifestPath})`,
          ),
        );
        console.log(
          table([
            ["logs", String(summary.counts.logs)],
            ["spans", String(summary.counts.spans)],
            ["metrics", String(summary.counts.metrics)],
            ["sessions", String(summary.counts.sessions)],
            ["messages", String(summary.counts.messages)],
          ]),
        );
        process.exit(0);
      },
    );

  cmd
    .command("backfill")
    .description("Backfill observer projections from control-plane records")
    .option("--dry-run", "count without writing")
    .action((opts: { dryRun?: boolean }) => {
      const org = organizationId();
      const repo = repoFor(org);
      const result = backfillFromControlPlane(repo, { organizationId: org, dryRun: opts.dryRun });
      console.log(pc.cyan("Backfill result"));
      console.log(
        table([
          ["candidates", String(result.candidates)],
          ["inserted logs", String(result.insertedLogs)],
          ["inserted metrics", String(result.insertedMetrics)],
          ["sessions", String(result.sessions)],
          ["skipped", String(result.skipped)],
          ["failed", String(result.failed)],
          ["dry run", String(result.dryRun)],
        ]),
      );
      process.exit(0);
    });

  cmd
    .command("diagnose")
    .description("Show ingestion errors and import health")
    .action(() => {
      const org = organizationId();
      const repo = repoFor(org);
      const errors = repo.queryIngestErrors({ organizationId: org, limit: 20 });
      const imports = repo.listImportState(org);
      console.log(pc.cyan("Diagnostics"));
      console.log(pc.yellow(`Ingestion errors (${errors.total ?? errors.rows.length}):`));
      for (const e of errors.rows) {
        console.log(
          `  ${pc.red(String(e.kind)).padEnd(24)} ${pc.gray(String(e.ts))} ${String(e.message)}`,
        );
      }
      console.log(pc.yellow(`Import state (${imports.length} files):`));
      for (const s of imports) {
        console.log(
          `  ${pc.green(s.status).padEnd(10)} ${pc.gray(s.source)} ${s.filePath} (${s.byteOffset} bytes)`,
        );
      }
      process.exit(0);
    });

  cmd
    .command("delete <scope>")
    .description("Delete telemetry data (logs, traces, metrics, sessions, all)")
    .option("--from <iso>", "start time")
    .option("--to <iso>", "end time")
    .option("--yes", "skip confirmation")
    .action((scope: string, opts: { from?: string; to?: string; yes?: boolean }) => {
      const valid = ["logs", "traces", "metrics", "sessions", "all"];
      if (!valid.includes(scope)) {
        console.error(pc.red(`unknown scope: ${scope} (valid: ${valid.join(", ")})`));
        process.exit(1);
      }
      const org = organizationId();
      const repo = repoFor(org);
      const counts = repo.countInRange({
        organizationId: org,
        scopes: [scope],
        from: opts.from,
        to: opts.to,
      });
      console.log(pc.cyan("Delete preview"));
      console.log(
        table([
          ["scope", scope],
          ["logs", String(counts.logs)],
          ["spans", String(counts.spans)],
          ["metrics", String(counts.metrics)],
          ["sessions", String(counts.sessions)],
        ]),
      );
      if (!opts.yes) {
        console.log("Run with --yes to confirm.");
        process.exit(0);
      }
      const result = repo.deleteInRange({
        organizationId: org,
        scopes: [scope],
        from: opts.from,
        to: opts.to,
      });
      console.log(pc.green("Deleted:"));
      console.log(
        table([
          ["logs", String(result.logs)],
          ["spans", String(result.spans)],
          ["metrics", String(result.metrics)],
          ["sessions", String(result.sessions)],
        ]),
      );
      process.exit(0);
    });

  return cmd;
}
