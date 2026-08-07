import { ConfigEditor } from "@/components/config/config-editor";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isAaspaiWorkspace } from "@/lib/aaspai";
import { CONFIG_SCHEMA, readConfig } from "@/lib/config-store";

export const dynamic = "force-dynamic";

export default async function ConfigSettingsPage() {
  if (!isAaspaiWorkspace())
    return (
      <Card>
        <CardHeader>
          <CardTitle>Configuration</CardTitle>
          <CardDescription>Initialize a workspace to manage settings.</CardDescription>
        </CardHeader>
      </Card>
    );
  const config = await readConfig();
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Configuration</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Edit{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">.aaspai/aaspai.config.json</code>
          .
        </p>
      </header>
      <ConfigEditor sections={CONFIG_SCHEMA} initial={config as Record<string, unknown>} />
    </div>
  );
}
