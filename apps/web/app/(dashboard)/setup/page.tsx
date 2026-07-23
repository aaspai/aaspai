import { getAdapter, listAdapters } from "@aaspai/harness";
import { CheckCircle2, CircleAlert, CircleX, Terminal } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isAaspaiWorkspace, workspaceRoot } from "@/lib/aaspai";

export const dynamic = "force-dynamic";

const adapterTypes = ["codex_local", "claude_local", "opencode_cli"] as const;

export default async function SetupPage() {
  const adapters = await Promise.all(
    adapterTypes.map(async (type) => {
      const info = listAdapters().find((adapter) => adapter.type === type);
      const environment = await getAdapter(type).testEnvironment({
        config: {},
        cwd: workspaceRoot(),
      });
      const installed = !environment.checks.some(
        (check) => check.name.endsWith("_cli") && /not found|enoent/i.test(check.message),
      );
      return { type, label: info?.label ?? type, installed, ready: environment.ok, environment };
    }),
  );
  const workspaceReady = isAaspaiWorkspace();

  return (
    <div className="space-y-8">
      <header>
        <p className="text-sm font-medium text-primary">System setup</p>
        <h1 className="text-2xl font-semibold tracking-tight">Connect the execution engine</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Verify the local agent CLIs and the company workspace before assigning real work.
        </p>
      </header>

      <section className="grid gap-4 lg:grid-cols-3">
        {adapters.map((adapter) => {
          const Icon = adapter.ready ? CheckCircle2 : adapter.installed ? CircleAlert : CircleX;
          return (
            <Card key={adapter.type}>
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="text-base">{adapter.label}</CardTitle>
                  <Badge variant={adapter.ready ? "default" : "outline"}>
                    {adapter.ready
                      ? "Ready"
                      : adapter.installed
                        ? "Needs attention"
                        : "Not installed"}
                  </Badge>
                </div>
                <CardDescription>{adapter.type}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Icon
                  className={
                    adapter.ready
                      ? "h-5 w-5 text-emerald-600"
                      : adapter.installed
                        ? "h-5 w-5 text-amber-600"
                        : "h-5 w-5 text-destructive"
                  }
                />
                <ul className="space-y-2 text-xs text-muted-foreground">
                  {adapter.environment.checks.map((check) => (
                    <li key={check.name} className="break-words">
                      {check.message}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          );
        })}
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Company workspace</CardTitle>
            <CardDescription>{workspaceRoot()}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-2 text-sm">
              {workspaceReady ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              ) : (
                <CircleX className="h-4 w-4 text-destructive" />
              )}
              {workspaceReady ? "Company definitions found" : "No company has been initialized"}
            </div>
            {workspaceReady ? (
              <Button asChild>
                <Link href="/company">Open command center</Link>
              </Button>
            ) : (
              <div className="rounded-md bg-muted p-3 text-xs">
                <div className="mb-2 flex items-center gap-2 font-medium">
                  <Terminal className="h-3.5 w-3.5" />
                  Initialize this directory
                </div>
                <code>aaspai init</code>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Access boundary</CardTitle>
            <CardDescription>Current self-hosted mode</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center gap-2 text-amber-700">
              <CircleAlert className="h-4 w-4" />
              Frontend login is not configured.
            </div>
            <p className="text-muted-foreground">
              Keep the web process bound to localhost. Remote or shared access is not safe until the
              authentication composition root is connected.
            </p>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
