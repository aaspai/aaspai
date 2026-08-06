import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getObserverImports } from "@/lib/observer";
import { formatRelative } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function ObserverImportsPage() {
  const imports = getObserverImports();

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Import status</h1>
          <p className="text-sm text-muted-foreground">
            File cursors and health for provider session imports and watching.
          </p>
        </div>
        <Link href="/observer" className="text-xs text-primary hover:underline">
          ← Overview
        </Link>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Files ({imports.length})</CardTitle>
          <CardDescription>Byte offsets advance only after durable success.</CardDescription>
        </CardHeader>
        <CardContent>
          {imports.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No files imported yet. Use <code>aaspai observe import &lt;source&gt;</code> or the
              API.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="px-2 py-2">Status</th>
                    <th className="px-2 py-2">Source</th>
                    <th className="px-2 py-2">File</th>
                    <th className="px-2 py-2 text-right">Records</th>
                    <th className="px-2 py-2 text-right">Offset</th>
                    <th className="px-2 py-2">Imported</th>
                    <th className="px-2 py-2">Last error</th>
                  </tr>
                </thead>
                <tbody>
                  {imports.map((s) => (
                    <tr key={`${s.source}:${s.filePath}`} className="border-b last:border-0">
                      <td className="px-2 py-2">
                        <Badge
                          variant={
                            s.status === "error"
                              ? "destructive"
                              : s.status === "current"
                                ? "default"
                                : "secondary"
                          }
                        >
                          {s.status}
                        </Badge>
                      </td>
                      <td className="px-2 py-2 font-mono text-xs">{s.source}</td>
                      <td className="max-w-md truncate px-2 py-2 font-mono text-[11px] text-muted-foreground">
                        {s.filePath}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">{Number(s.recordCount)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{Number(s.byteOffset)}</td>
                      <td className="px-2 py-2 font-mono text-[11px] text-muted-foreground">
                        {formatRelative(String(s.importedAt))}
                      </td>
                      <td className="max-w-xs truncate px-2 py-2 text-[11px] text-destructive">
                        {s.lastError ? String(s.lastError) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
