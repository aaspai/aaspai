import { KeyConfigEditor } from "@/components/config/key-config-editor";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isAaspaiWorkspace } from "@/lib/aaspai";
import { readEnvFile } from "@/lib/env-file";
import {
  type EnvVarInfo,
  isCatalogKey,
  KEY_CATALOG,
  providerGroupName,
  providerPriority,
  redact,
} from "@/lib/key-catalog";

export const dynamic = "force-dynamic";

export default async function KeysSettingsPage() {
  if (!isAaspaiWorkspace())
    return (
      <Card>
        <CardHeader>
          <CardTitle>Keys</CardTitle>
          <CardDescription>Initialize a workspace to manage keys.</CardDescription>
        </CardHeader>
      </Card>
    );

  const entries = await readEnvFile();
  const setKeys = new Set(entries.map((e) => e.key));

  const known = Object.entries(KEY_CATALOG).map(([key, info]) => {
    const value = entries.find((e) => e.key === key)?.value;
    return {
      key,
      isSet: setKeys.has(key),
      redactedValue: value ? redact(value) : null,
      group: providerGroupName(key),
      groupPriority: providerPriority(key),
      info,
    };
  });

  const custom = entries
    .filter((e) => !isCatalogKey(e.key))
    .map((e) => ({
      key: e.key,
      isSet: true,
      redactedValue: redact(e.value),
      group: "Custom",
      groupPriority: 100,
      info: {
        category: "provider" as const,
        provider: "Custom",
        description: "User-added environment variable.",
        password: true,
        custom: true,
      } as EnvVarInfo,
    }));

  const keys = [...known, ...custom].sort(
    (a, b) => a.groupPriority - b.groupPriority || a.key.localeCompare(b.key),
  );

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Keys</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Secrets stored in{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">.env.local</code>. Values are
          shown redacted until you reveal them.
        </p>
      </header>
      <KeyConfigEditor initialKeys={keys} />
    </div>
  );
}
