import { Database, KeyRound, PlugZap, ServerCog, Settings2 } from "lucide-react";
import Link from "next/link";
import { CompanyBackup } from "@/components/company-backup";
import { SystemPanel } from "@/components/system-panel";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isAaspaiWorkspace } from "@/lib/aaspai";

export const dynamic = "force-dynamic";

const SETTINGS_LINKS = [
  {
    href: "/settings/config",
    title: "Configuration",
    description: "Edit aaspai.config.json — organization, database, paths, sandbox defaults.",
    icon: Settings2,
  },
  {
    href: "/settings/keys",
    title: "Keys",
    description: "Manage provider API keys in .env.local (redacted, reveal-on-demand).",
    icon: KeyRound,
  },
  {
    href: "/setup",
    title: "Setup",
    description: "Verify local agent CLIs and the company workspace.",
    icon: PlugZap,
  },
  {
    href: "/agents",
    title: "Agents",
    description: "Browse agents, their roles, system prompts, and recent activity.",
    icon: Database,
  },
];

export default function SettingsPage() {
  const workspaceReady = isAaspaiWorkspace();
  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure the aaspai workspace, secrets, and system daemons.
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-2">
        {SETTINGS_LINKS.map((link) => (
          <Link key={link.href} href={link.href}>
            <Card className="h-full transition-colors hover:bg-accent/30">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <link.icon className="h-4 w-4 text-muted-foreground" />
                  <CardTitle className="text-base">{link.title}</CardTitle>
                </div>
                <CardDescription>{link.description}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </section>

      {workspaceReady && (
        <section>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ServerCog className="h-4 w-4" />
                System daemons
              </CardTitle>
              <CardDescription>
                Worker and API processes that drive loops and sessions. Restarting signals the
                daemon; the supervisor respawns it.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <SystemPanel />
            </CardContent>
          </Card>
        </section>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Badge variant="secondary">2</Badge>
            Company backup and recovery
          </CardTitle>
          <CardDescription>
            Version 2 includes strategy, execution definitions and work, knowledge, evidence, and
            governance records.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CompanyBackup />
        </CardContent>
      </Card>
    </div>
  );
}
