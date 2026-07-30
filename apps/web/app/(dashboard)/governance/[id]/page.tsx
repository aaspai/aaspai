import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DecisionActions } from "@/components/company-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCompanyOverview, isAaspaiWorkspace } from "@/lib/aaspai";
import { formatRelative } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function DecisionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  if (!isAaspaiWorkspace()) notFound();
  const { id } = await params;
  const overview = await getCompanyOverview();
  const approval = overview.approvals.find((item) => item.id === decodeURIComponent(id));
  if (!approval) notFound();

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/governance">
          <ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> All decisions
        </Link>
      </Button>
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            {approval.workItemTitle ?? "Founder decision"}
          </h1>
          <Badge variant={approval.status === "rejected" ? "destructive" : "secondary"}>
            {approval.status}
          </Badge>
        </div>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          {approval.reason || "The company needs explicit approval before continuing."}
        </p>
      </header>
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>Decision record</CardTitle>
          <CardDescription>Authority and execution lineage for this request.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <Row
            label="Work item"
            value={approval.workItemTitle ?? approval.workItemId}
            href={`/work/${encodeURIComponent(approval.workItemId)}`}
          />
          <Row label="Authority" value={approval.actorType} />
          <Row label="Requested" value={formatRelative(approval.requestedAt)} />
          <Row
            label="Expires"
            value={approval.expiresAt ? formatRelative(approval.expiresAt) : "No expiry"}
          />
          {approval.attemptId && (
            <Row
              label="Attempt"
              value={approval.attemptId}
              href={`/execution/attempts/${encodeURIComponent(approval.attemptId)}`}
            />
          )}
          {approval.status === "requested" && <DecisionActions approvalId={approval.id} />}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b pb-3 last:border-0 last:pb-0">
      <span className="text-xs uppercase tracking-wider text-muted-foreground">{label}</span>
      {href ? (
        <Link href={href} className="max-w-md break-all text-right text-primary hover:underline">
          {value}
        </Link>
      ) : (
        <span className="text-right">{value}</span>
      )}
    </div>
  );
}
