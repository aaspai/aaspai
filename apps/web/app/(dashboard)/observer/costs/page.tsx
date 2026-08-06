import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getObserverCosts } from "@/lib/observer";

export const dynamic = "force-dynamic";

export default async function ObserverCostsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const groupBy = typeof sp.groupBy === "string" ? sp.groupBy : "provider";
  const rows = getObserverCosts(
    groupBy === "model"
      ? "model"
      : groupBy === "session"
        ? "session"
        : groupBy === "execution"
          ? "execution"
          : groupBy === "user"
            ? "user"
            : groupBy === "day"
              ? "day"
              : "provider",
  );

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Costs</h1>
          <p className="text-sm text-muted-foreground">
            Aggregated from cost metrics. Unknown pricing is never shown as zero.
          </p>
        </div>
        <Link href="/observer" className="text-xs text-primary hover:underline">
          ← Overview
        </Link>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Group by</CardTitle>
        </CardHeader>
        <CardContent>
          <nav className="flex flex-wrap gap-2 text-sm">
            {["provider", "model", "session", "execution", "user", "day"].map((g) => (
              <Link
                key={g}
                href={`/observer/costs?groupBy=${g}`}
                className={`rounded border px-2 py-1 ${groupBy === g ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
              >
                {g}
              </Link>
            ))}
          </nav>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cost breakdown</CardTitle>
          <CardDescription>Total estimated / reported cost by {groupBy}.</CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No cost data yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-2 py-2">{groupBy}</th>
                  <th className="px-2 py-2 text-right">Records</th>
                  <th className="px-2 py-2 text-right">Cost (USD)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={String(r.key)} className="border-b last:border-0">
                    <td className="px-2 py-2 font-mono text-xs">{String(r.key)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{Number(r.records)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {r.costUsd != null ? `$${Number(r.costUsd).toFixed(4)}` : "unknown"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
