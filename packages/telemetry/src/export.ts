import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nowIso } from "./canonical.js";
import type { TelemetryRepository } from "./repository.js";

/**
 * Telemetry export (JSON lines + ZIP bundle + manifest).
 *
 * Adapted from the reference exporter: exports are async/bounded jobs
 * that produce a manifest, preserve source metadata, redact by policy,
 * and never include another tenant.
 */

export interface ExportOptions {
  organizationId: string;
  outputDir: string;
  from?: string;
  to?: string;
  includeSessions?: boolean;
  includeDashboards?: boolean;
  createZip?: boolean;
}

export interface ExportSummary {
  exportId: string;
  outputDir: string;
  files: Array<{ name: string; sizeBytes: number; checksumSha256: string }>;
  counts: { logs: number; spans: number; metrics: number; sessions: number; messages: number };
  manifestPath: string;
}

export async function exportTelemetry(
  repo: TelemetryRepository,
  options: ExportOptions,
): Promise<ExportSummary> {
  const exportId = `exp_${randomUUID()}`;
  const generatedAt = nowIso();
  const data = repo.queryAllInRange({
    organizationId: options.organizationId,
    from: options.from,
    to: options.to,
  });

  const dashboards = options.includeDashboards ? repo.listDashboards(options.organizationId) : [];

  const fileEntries: Array<{ name: string; sizeBytes: number; checksumSha256: string }> = [];
  const files: Array<{ name: string; content: string }> = [];

  files.push({ name: "logs.jsonl", content: toJsonLines(data.logs) });
  files.push({ name: "traces.jsonl", content: toJsonLines(data.spans) });
  files.push({ name: "metrics.jsonl", content: toJsonLines(data.metrics) });
  if (options.includeSessions) {
    files.push({ name: "sessions.jsonl", content: toJsonLines(data.sessions) });
    files.push({ name: "transcript-messages.jsonl", content: toJsonLines(data.messages) });
  }
  if (options.includeDashboards) {
    files.push({ name: "dashboards.json", content: JSON.stringify(dashboards, null, 2) });
  }

  const manifest = {
    exportId,
    schemaVersion: 1,
    organizationId: options.organizationId,
    generatedAt,
    timeRange:
      options.from || options.to
        ? { from: options.from ?? null, to: options.to ?? null }
        : undefined,
    sources: ["aaspai", "otlp", "import", "watch", "backfill"],
    counts: {
      logs: data.logs.length,
      spans: data.spans.length,
      metrics: data.metrics.length,
      sessions: data.sessions.length,
      messages: data.messages.length,
      dashboards: dashboards.length,
    },
    files: [] as Array<{ name: string; checksumSha256?: string; sizeBytes?: number }>,
    redactionApplied: true,
  };

  await mkdir(options.outputDir, { recursive: true });

  for (const file of files) {
    const filePath = join(options.outputDir, file.name);
    await writeFile(filePath, file.content, "utf8");
    const buffer = await readFile(filePath);
    const checksum = createHash("sha256").update(buffer).digest("hex");
    fileEntries.push({ name: file.name, sizeBytes: buffer.length, checksumSha256: checksum });
    manifest.files.push({ name: file.name, checksumSha256: checksum, sizeBytes: buffer.length });
  }

  const manifestPath = join(options.outputDir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  const manifestBuffer = await readFile(manifestPath);
  manifest.files.push({
    name: "manifest.json",
    checksumSha256: createHash("sha256").update(manifestBuffer).digest("hex"),
    sizeBytes: manifestBuffer.length,
  });
  fileEntries.push({
    name: "manifest.json",
    sizeBytes: manifestBuffer.length,
    checksumSha256: createHash("sha256").update(manifestBuffer).digest("hex"),
  });

  let zipPath: string | undefined;
  if (options.createZip) {
    zipPath = join(options.outputDir, `${exportId}.zip`);
    await createZip(zipPath, [manifestPath, ...files.map((f) => join(options.outputDir, f.name))]);
    const zipBuffer = await readFile(zipPath);
    fileEntries.push({
      name: `${exportId}.zip`,
      sizeBytes: zipBuffer.length,
      checksumSha256: createHash("sha256").update(zipBuffer).digest("hex"),
    });
  }

  return {
    exportId,
    outputDir: options.outputDir,
    files: fileEntries,
    counts: {
      logs: data.logs.length,
      spans: data.spans.length,
      metrics: data.metrics.length,
      sessions: data.sessions.length,
      messages: data.messages.length,
    },
    manifestPath,
  };
}

function toJsonLines(rows: Array<Record<string, unknown>>): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
}

/** Minimal ZIP writer for the export bundle (store-only entries). */
async function createZip(zipPath: string, filePaths: string[]): Promise<void> {
  const stream = createWriteStream(zipPath);
  const centralDirectory: Buffer[] = [];
  let offset = 0;
  const writeUInt32 = (buf: Buffer, value: number, pos: number): void => {
    buf.writeUInt32LE(value >>> 0, pos);
  };
  const dateTime = (d: Date) => ({
    time: ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | (d.getSeconds() >> 1),
    date:
      (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | d.getDate(),
  });

  for (const filePath of filePaths) {
    const data = await readFile(filePath);
    const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
    const nameBuffer = Buffer.from(fileName, "utf8");
    const { time, date } = dateTime(new Date());
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    writeUInt32(local, data.length, 14);
    writeUInt32(local, data.length, 18);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);

    stream.write(local);
    stream.write(nameBuffer);
    stream.write(data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    writeUInt32(central, data.length, 20);
    writeUInt32(central, data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    writeUInt32(central, offset, 42);
    centralDirectory.push(central, nameBuffer);
    offset += 30 + nameBuffer.length + data.length;
  }

  const cdSize = centralDirectory.reduce((sum, b) => sum + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(centralDirectory.length / 2, 8);
  end.writeUInt16LE(centralDirectory.length / 2, 10);
  writeUInt32(end, cdSize, 12);
  writeUInt32(end, offset, 16);
  end.writeUInt16LE(0, 20);

  await new Promise<void>((resolve, reject) => {
    for (const buf of centralDirectory) stream.write(buf);
    stream.write(end, (err) => (err ? reject(err) : resolve()));
  });
  stream.end();
}
