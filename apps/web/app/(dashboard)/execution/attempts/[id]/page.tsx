import {
  ArrowLeft,
  CheckCircle2,
  CircleAlert,
  Clock3,
  FileBox,
  GitBranch,
  Layers3,
} from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getExecutionAttemptDetail, isAaspaiWorkspace } from "@/lib/aaspai";

export const dynamic = "force-dynamic";

export default async function ExecutionAttemptPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!isAaspaiWorkspace()) notFound();
  const detail = await getExecutionAttemptDetail(decodeURIComponent(id));
  if (!detail) notFound();
  const json = (value: unknown) => JSON.stringify(value, null, 2);
  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/execution">
          <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
          All execution
        </Link>
      </Button>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">Execution attempt</h1>
            <Badge
              variant={
                detail.attempt.status === "succeeded"
                  ? "default"
                  : detail.attempt.status === "failed"
                    ? "destructive"
                    : "secondary"
              }
            >
              {detail.attempt.status}
            </Badge>
          </div>
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
            {detail.attempt.id}
          </p>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          <div>{detail.attempt.agentId}</div>
          <div>{detail.attempt.harness}</div>
        </div>
      </header>
      <div className="grid gap-4 md:grid-cols-3">
        <LineageCard
          icon={<Layers3 className="h-4 w-4" />}
          title="Goal / project"
          value={`${String(detail.goal?.title ?? "—")} / ${String(detail.project?.title ?? "—")}`}
        />
        <LineageCard
          icon={<GitBranch className="h-4 w-4" />}
          title="Repository"
          value={String(detail.repository?.localPath ?? "—")}
        />
        <LineageCard
          icon={<Clock3 className="h-4 w-4" />}
          title="Attempt"
          value={`${detail.attempt.startedAt ?? "not started"} → ${detail.attempt.finishedAt ?? "running"}`}
        />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Execution lineage</CardTitle>
          <CardDescription>
            Immutable definition, source, workspace, and runtime plan.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2">
            <Field
              label="Work item"
              value={String(detail.workItem?.title ?? detail.attempt.workItemId)}
            />
            <Field
              label="Definition revision"
              value={`${String(detail.revision?.id ?? "—")} @ ${String(detail.revision?.commitSha ?? "—")}`}
              mono
            />
            <Field label="Source snapshot" value={json(detail.plan?.sourceSnapshot ?? {})} code />
            <Field label="Workspace" value={json(detail.workspace ?? {})} code />
            <Field label="Harness session" value={json(detail.harnessSession ?? {})} code />
            {typeof detail.harnessSession?.id === "string" ? (
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground">
                  Session explorer
                </div>
                <Link
                  className="mt-1 inline-block text-sm text-primary underline underline-offset-4"
                  href={`/sessions/${encodeURIComponent(detail.harnessSession.id)}`}
                >
                  Open complete harness transcript
                </Link>
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <span className="inline-flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-primary" />
              Event timeline
            </span>
          </CardTitle>
          <CardDescription>
            {detail.events.length} normalized events, ordered per attempt.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {detail.events.length === 0 ? (
              <p className="text-sm text-muted-foreground">No events recorded.</p>
            ) : (
              detail.events.map((event) => (
                <div key={event.id} className="rounded-md border p-3">
                  <div className="flex flex-wrap justify-between gap-2">
                    <span className="font-mono text-xs font-medium">
                      #{event.seq} {event.type}
                    </span>
                    <span className="text-xs text-muted-foreground">{event.ts}</span>
                  </div>
                  <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">
                    {json(event.payload)}
                  </pre>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <span className="inline-flex items-center gap-2">
              <FileBox className="h-4 w-4" />
              Artifacts
            </span>
          </CardTitle>
          <CardDescription>Durable references produced by the attempt.</CardDescription>
        </CardHeader>
        <CardContent>
          {detail.artifacts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No artifacts recorded.</p>
          ) : (
            <div className="space-y-2">
              {detail.artifacts.map((artifact) => (
                <pre
                  key={String(artifact.id)}
                  className="overflow-auto rounded bg-muted p-3 text-xs"
                >
                  {json(artifact)}
                </pre>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      {detail.attempt.error ? (
        <Card className="border-destructive">
          <CardHeader>
            <CardTitle>
              <span className="inline-flex items-center gap-2">
                <CircleAlert className="h-4 w-4" />
                Error
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="whitespace-pre-wrap text-sm">{detail.attempt.error}</pre>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function LineageCard({
  icon,
  title,
  value,
}: {
  icon: React.ReactNode;
  title: string;
  value: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription className="flex items-center gap-2">
          {icon}
          {title}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="break-all text-sm font-medium">{value}</p>
      </CardContent>
    </Card>
  );
}
function Field({
  label,
  value,
  mono,
  code,
}: {
  label: string;
  value: string;
  mono?: boolean;
  code?: boolean;
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      {code ? (
        <pre className="mt-1 max-h-36 overflow-auto rounded bg-muted p-3 text-xs">{value}</pre>
      ) : (
        <div className={`mt-1 break-all text-sm ${mono ? "font-mono" : ""}`}>{value}</div>
      )}
    </div>
  );
}
