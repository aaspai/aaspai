import { CheckCircle2, Inbox, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCompanyOverview, getStrategicSummary, isAaspaiWorkspace } from "@/lib/aaspai";

export const dynamic = "force-dynamic";

export default async function InboxPage() {
  if (!isAaspaiWorkspace())
    return (
      <Card>
        <CardHeader>
          <CardTitle>Human inbox</CardTitle>
          <CardDescription>Initialize a workspace to review company decisions.</CardDescription>
        </CardHeader>
      </Card>
    );
  const [overview, strategic] = await Promise.all([getCompanyOverview(), getStrategicSummary()]);
  const pending = overview.inbox;
  return (
    <div className="space-y-6">
      <header>
        <div className="flex items-center gap-2">
          <Inbox className="h-5 w-5" />
          <h1 className="text-3xl font-semibold tracking-tight">Human inbox</h1>
          <Badge variant="secondary">{pending.length} pending</Badge>
        </div>
        <p className="mt-2 text-muted-foreground">
          Approvals and strategic signals that require founder attention.
        </p>
      </header>
      <div className="grid gap-4 md:grid-cols-3">
        <Metric
          label="Pending approvals"
          value={pending.filter((item) => item.kind === "approval").length}
        />
        <Metric
          label="At-risk projects"
          value={
            strategic?.projects.filter((project) => project.healthStatus !== "healthy").length ?? 0
          }
        />
        <Metric label="Company state" value={strategic?.profile?.lifecycleStatus ?? "draft"} />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Review queue</CardTitle>
          <CardDescription>External actions remain gated until you decide.</CardDescription>
        </CardHeader>
        <CardContent>
          {pending.length === 0 ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <CheckCircle2 className="h-4 w-4" />
              Nothing needs your decision.
            </div>
          ) : (
            <div className="space-y-3">
              {pending.map((item) => (
                <div
                  key={item.id}
                  className="flex items-start justify-between gap-3 rounded-lg border p-3"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <ShieldAlert className="h-4 w-4 text-amber-500" />
                      <p className="font-medium">{item.title}</p>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {item.detail || "Founder review requested"}
                    </p>
                  </div>
                  <Badge>{item.status}</Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}
