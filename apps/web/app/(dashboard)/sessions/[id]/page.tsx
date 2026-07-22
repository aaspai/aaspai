import {
  ArrowLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleX,
  Clock,
  Coins,
  Cpu,
  FileCode2,
  FileText,
  Layers,
  ScrollText,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { TranscriptEntry, TranscriptKind } from "@/lib/aaspai";
import { getSessionDetail, isAaspaiWorkspace } from "@/lib/aaspai";
import { formatRelative } from "@/lib/utils";

export const dynamic = "force-dynamic";

const STATUS_VARIANT = {
  succeeded: "default",
  completed: "default",
  failed: "destructive",
  cancelled: "secondary",
  paused_for_question: "secondary",
  timed_out: "destructive",
  interrupted: "destructive",
  queued: "secondary",
  running: "secondary",
} as const;

function StatusBadge({ status }: { status: string }) {
  const variant =
    (STATUS_VARIANT as Record<string, (typeof STATUS_VARIANT)[keyof typeof STATUS_VARIANT]>)[
      status
    ] ?? "secondary";
  return <Badge variant={variant}>{status}</Badge>;
}

export default async function SessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sessionId = decodeURIComponent(id);

  if (!isAaspaiWorkspace()) notFound();
  const session = await getSessionDetail(sessionId);
  if (!session) notFound();

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/sessions">
          <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
          All sessions
        </Link>
      </Button>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">Session run</h1>
            <StatusBadge status={session.status} />
          </div>
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{session.id}</p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href={`/agents/${encodeURIComponent(session.agentId)}`}>
            View agent <ChevronRight className="ml-1.5 h-3.5 w-3.5" />
          </Link>
        </Button>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Agent"
          value={session.agentId.replace(/^agent\//, "")}
          href={`/agents/${encodeURIComponent(session.agentId)}`}
          icon={Cpu}
        />
        <Stat label="Adapter" value={session.adapter} icon={Layers} />
        <Stat label="Started" value={formatRelative(session.startedAt)} icon={Clock} />
        <Stat
          label="Duration"
          value={session.durationMs != null ? `${session.durationMs} ms` : "—"}
          icon={Clock}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Execution context</CardTitle>
          <CardDescription>
            Identifiers and lifecycle timestamps recorded for this run.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Field label="session" value={session.id} mono />
            <Field label="display id" value={session.sessionDisplayId ?? "—"} mono />
            <Field label="wakeup" value={session.wakeupId ?? "manual"} mono />
            <Field label="parent session" value={session.parentSessionId ?? "—"} mono />
            <Field label="started" value={formatExact(session.startedAt)} />
            <Field label="finished" value={formatExact(session.finishedAt)} />
          </dl>
        </CardContent>
      </Card>

      {session.errorMessage && (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <CircleAlert className="h-4 w-4" />
              Error
            </CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="overflow-x-auto rounded-md bg-destructive/5 p-3 text-xs leading-relaxed whitespace-pre-wrap text-destructive">
              {session.errorMessage}
            </pre>
          </CardContent>
        </Card>
      )}

      {session.result && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CircleCheck className="h-4 w-4 text-emerald-600" />
              Result
            </CardTitle>
            <CardDescription>The harness adapter's final result for this run.</CardDescription>
          </CardHeader>
          <CardContent>
            <ResultView result={session.result} />
          </CardContent>
        </Card>
      )}

      {session.usage && Object.keys(session.usage).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Coins className="h-4 w-4" />
              Usage
            </CardTitle>
          </CardHeader>
          <CardContent>
            <UsageView usage={session.usage} />
          </CardContent>
        </Card>
      )}

      {session.wakeup && <WakeupCard wakeup={session.wakeup} />}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-4 w-4" />
            Prompt
          </CardTitle>
          <CardDescription>What was sent to the adapter for this run.</CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed whitespace-pre-wrap">
            {session.prompt || "(empty)"}
          </pre>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <JsonCard title="Session configuration" data={session.config} />
        <JsonCard title="Runtime configuration" data={session.runtime} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ScrollText className="h-4 w-4" />
            Transcript
          </CardTitle>
          <CardDescription>
            {session.transcript.length === 0
              ? "No events recorded for this session."
              : `${session.transcript.length} event${session.transcript.length === 1 ? "" : "s"} in chronological order.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {session.transcript.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              The harness adapter did not stream any events for this run. The result above is the
              full output.
            </p>
          ) : (
            <ol className="space-y-3">
              {session.transcript.map((entry) => (
                <li key={entry.seq}>
                  <TranscriptRow entry={entry} />
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({
  label,
  value,
  href,
  icon: Icon,
}: {
  label: string;
  value: string;
  href?: string;
  icon: typeof Clock;
}) {
  const body = (
    <Card>
      <CardContent className="flex items-center justify-between p-4">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {label}
          </p>
          <p className="mt-1 truncate text-sm font-semibold tabular-nums">{value || "—"}</p>
        </div>
        <div className="rounded-md bg-muted/60 p-2 text-muted-foreground">
          <Icon className="h-3.5 w-3.5" />
        </div>
      </CardContent>
    </Card>
  );
  if (!href) return body;
  return (
    <Link href={href} className="block transition-opacity hover:opacity-80">
      {body}
    </Link>
  );
}

function ResultView({ result }: { result: Record<string, unknown> }) {
  const text = (result as { text?: unknown }).text;
  const summary = (result as { summary?: unknown }).summary;
  const role = (result as { role?: unknown }).role;
  const dryRun = (result as { dryRun?: unknown }).dryRun;
  const response = (result as { response?: unknown }).response;
  const facts = [
    ["status", result.status],
    ["exit code", result.exitCode],
    ["error family", result.errorFamily],
    ["error code", result.errorCode],
    ["provider", result.provider],
    ["model", result.model],
    ["session", result.sessionId],
  ] as const;

  return (
    <div className="space-y-3">
      {facts.some(([, value]) => value != null) && (
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {facts.map(([label, value]) =>
            value == null ? null : <Field key={label} label={label} value={String(value)} mono />,
          )}
        </dl>
      )}
      {(role || dryRun != null) && (
        <div className="flex flex-wrap gap-1.5">
          {role != null && <Badge variant="secondary">role: {String(role)}</Badge>}
          {dryRun != null && <Badge variant="outline">dry-run: {String(dryRun)}</Badge>}
        </div>
      )}
      {typeof text === "string" && text.length > 0 ? (
        <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-sm leading-relaxed whitespace-pre-wrap">
          {text}
        </pre>
      ) : typeof response === "string" && response.length > 0 ? (
        <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-sm leading-relaxed whitespace-pre-wrap">
          {response}
        </pre>
      ) : typeof summary === "string" ? (
        <p className="text-sm text-muted-foreground">{summary}</p>
      ) : (
        <JsonView data={result} />
      )}
    </div>
  );
}

function UsageView({ usage }: { usage: Record<string, unknown> }) {
  const inputTokens = (usage as { inputTokens?: number }).inputTokens;
  const outputTokens = (usage as { outputTokens?: number }).outputTokens;
  const cost = (usage as { costUsd?: number }).costUsd;
  const duration = (usage as { durationMs?: number }).durationMs;
  return (
    <div className="grid gap-3 sm:grid-cols-4">
      {inputTokens != null && <UsageStat label="Input tokens" value={inputTokens} />}
      {outputTokens != null && <UsageStat label="Output tokens" value={outputTokens} />}
      {cost != null && <UsageStat label="Cost (USD)" value={`$${cost.toFixed(6)}`} />}
      {duration != null && <UsageStat label="Duration" value={`${duration} ms`} />}
    </div>
  );
}

function UsageStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border bg-background/50 p-3">
      <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function JsonCard({ title, data }: { title: string; data: Record<string, unknown> }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
        <CardDescription>Raw structured data captured with the session.</CardDescription>
      </CardHeader>
      <CardContent>
        <JsonView data={data} />
      </CardContent>
    </Card>
  );
}

function WakeupCard({
  wakeup,
}: {
  wakeup: NonNullable<Awaited<ReturnType<typeof getSessionDetail>>>["wakeup"];
}) {
  if (!wakeup) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <CircleDot className="h-4 w-4" />
          Triggering wakeup
          <Badge variant="secondary">{wakeup.status}</Badge>
        </CardTitle>
        <CardDescription>The wakeup that enqueued this session.</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <Field label="id" value={wakeup.id} mono />
          <Field label="loop" value={wakeup.loopId} mono />
          <Field label="source" value={wakeup.source ?? "—"} />
          <Field label="reason" value={wakeup.reason ?? "—"} />
          <Field label="requested" value={formatRelative(wakeup.requestedAt)} />
          <Field label="finished" value={formatRelative(wakeup.finishedAt)} />
        </dl>
        {wakeup.error && (
          <pre className="mt-3 overflow-x-auto rounded-md bg-destructive/5 p-3 text-xs leading-relaxed whitespace-pre-wrap text-destructive">
            {wakeup.error}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd
        className={
          mono
            ? "max-w-[75%] break-all text-right font-mono text-xs"
            : "max-w-[75%] text-right text-sm"
        }
      >
        {value}
      </dd>
    </div>
  );
}

function formatExact(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function JsonView({ data }: { data: unknown }) {
  return (
    <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed whitespace-pre-wrap">
      {JSON.stringify(data, null, 2) ?? "null"}
    </pre>
  );
}

// ─────────────────────────────────────────────────────────────────────
//  Transcript row
// ─────────────────────────────────────────────────────────────────────

const KIND_META: Record<
  TranscriptKind,
  {
    icon: typeof Cpu;
    label: string;
    tone: string;
  }
> = {
  init: { icon: CircleDot, label: "Init", tone: "text-blue-600" },
  system: { icon: CircleDot, label: "System", tone: "text-blue-600" },
  assistant: { icon: CircleCheck, label: "Assistant", tone: "text-emerald-600" },
  thinking: { icon: CircleDot, label: "Thinking", tone: "text-violet-600" },
  tool_call: { icon: Wrench, label: "Tool call", tone: "text-amber-600" },
  tool_result: { icon: FileCode2, label: "Tool result", tone: "text-cyan-600" },
  result: { icon: CircleCheck, label: "Result", tone: "text-emerald-600" },
  stdout: { icon: CircleDot, label: "stdout", tone: "text-muted-foreground" },
  stderr: { icon: CircleX, label: "stderr", tone: "text-destructive" },
  unknown: { icon: CircleDot, label: "Event", tone: "text-muted-foreground" },
};

function TranscriptRow({ entry }: { entry: TranscriptEntry }) {
  const meta = KIND_META[entry.kind] ?? KIND_META.unknown;
  const Icon = meta.icon;
  const tsLabel = formatRelative(entry.ts);

  return (
    <div className="rounded-md border bg-background/40 p-3">
      <div className="mb-1.5 flex items-center gap-2 text-xs">
        <span className="font-mono text-[10px] text-muted-foreground/70">#{entry.seq}</span>
        <Icon className={`h-3.5 w-3.5 ${meta.tone}`} />
        <span className={`font-semibold ${meta.tone}`}>{meta.label}</span>
        <span className="ml-auto text-muted-foreground">{tsLabel}</span>
      </div>
      <TranscriptBody entry={entry} />
    </div>
  );
}

function TranscriptBody({ entry }: { entry: TranscriptEntry }) {
  const p = entry.payload;
  const text = (p as { text?: unknown }).text;
  const name = (p as { name?: unknown }).name;
  const id = (p as { id?: unknown }).id;
  const status = (p as { status?: unknown }).status;
  const input =
    (p as { input?: unknown; arguments?: unknown }).input ??
    (p as { arguments?: unknown }).arguments;
  const output = (p as { output?: unknown }).output;
  const error = (p as { error?: unknown }).error;
  const isError = (p as { isError?: unknown }).isError;

  if (entry.kind === "tool_call" || entry.kind === "tool_result") {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {typeof name === "string" && <span className="font-mono font-semibold">{name}</span>}
          {typeof id === "string" && <span className="font-mono text-muted-foreground">{id}</span>}
          {typeof status === "string" && <Badge variant="secondary">{status}</Badge>}
          {isError === true && <Badge variant="destructive">error</Badge>}
        </div>
        {entry.kind === "tool_call" && input !== undefined && (
          <pre className="max-h-64 overflow-auto rounded bg-muted/60 p-2.5 text-xs leading-relaxed whitespace-pre-wrap">
            {typeof input === "string" ? input : JSON.stringify(input, null, 2)}
          </pre>
        )}
        {entry.kind === "tool_result" && error !== undefined && (
          <pre className="max-h-64 overflow-auto rounded bg-destructive/5 p-2.5 text-xs leading-relaxed whitespace-pre-wrap text-destructive">
            {typeof error === "string" ? error : JSON.stringify(error, null, 2)}
          </pre>
        )}
        {entry.kind === "tool_result" && output !== undefined && (
          <pre className="max-h-72 overflow-auto rounded bg-muted/60 p-2.5 text-xs leading-relaxed whitespace-pre-wrap">
            {typeof output === "string" ? output : JSON.stringify(output, null, 2)}
          </pre>
        )}
        {entry.kind === "tool_result" && error === undefined && output === undefined && (
          <JsonView data={p} />
        )}
      </div>
    );
  }

  if (typeof text === "string" && text.length > 0) {
    return (
      <pre className="max-h-72 overflow-auto rounded bg-muted/60 p-2.5 text-xs leading-relaxed whitespace-pre-wrap">
        {text}
      </pre>
    );
  }

  return <JsonView data={p} />;
}
