import { NextResponse } from "next/server";
import { isAaspaiWorkspace } from "@/lib/aaspai";
import { clearEnvValue, readEnvFile, setEnvValue } from "@/lib/env-file";
import {
  type EnvVarInfo,
  ensureWorkspaceEnvForCatalog,
  isCatalogKey,
  KEY_CATALOG,
  providerGroupName,
  providerPriority,
  redact,
} from "@/lib/key-catalog";
import { currentUser } from "@/lib/local-auth";

export const dynamic = "force-dynamic";

export interface KeyEntry {
  key: string;
  isSet: boolean;
  redactedValue: string | null;
  info: EnvVarInfo;
  group: string;
  groupPriority: number;
}

/** `GET /api/config/keys` — list every cataloged key + any custom keys,
 *  with redacted values only. */
export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!isAaspaiWorkspace()) {
    return NextResponse.json({ error: "no aaspai workspace" }, { status: 404 });
  }
  ensureWorkspaceEnvForCatalog();
  const entries = await readEnvFile();
  const setKeys = new Set(entries.map((e) => e.key));

  // Cataloged keys always appear (configured count tells the story);
  // custom keys only when present in the env file.
  const known = Object.entries(KEY_CATALOG).map(([key, info]) => {
    const value = entries.find((e) => e.key === key)?.value;
    return {
      key,
      isSet: setKeys.has(key),
      redactedValue: value ? redact(value) : null,
      info,
      group: providerGroupName(key),
      groupPriority: providerPriority(key),
    };
  });
  const custom = entries
    .filter((e) => !isCatalogKey(e.key))
    .map((e) => ({
      key: e.key,
      isSet: true,
      redactedValue: redact(e.value),
      info: {
        category: "provider" as const,
        provider: "Custom",
        description: "User-added environment variable.",
        password: true,
        custom: true,
      },
      group: "Custom",
      groupPriority: 100,
    }));

  const all: KeyEntry[] = [...known, ...custom].sort(
    (a, b) => a.groupPriority - b.groupPriority || a.key.localeCompare(b.key),
  );
  return NextResponse.json({ keys: all });
}

/** `PUT /api/config/keys` — set (create or replace) a key. */
export async function PUT(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!isAaspaiWorkspace()) {
    return NextResponse.json({ error: "no aaspai workspace" }, { status: 404 });
  }
  let body: { key?: unknown; value?: unknown };
  try {
    body = (await req.json()) as { key?: unknown; value?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const key = typeof body.key === "string" ? body.key.trim() : "";
  const value = typeof body.value === "string" ? body.value : "";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return NextResponse.json({ error: "invalid key name" }, { status: 400 });
  }
  if (!value) {
    return NextResponse.json({ error: "value required" }, { status: 400 });
  }
  await setEnvValue(key, value);
  return NextResponse.json({ key, isSet: true, redactedValue: redact(value) });
}

/** `DELETE /api/config/keys?key=X` — clear a key. */
export async function DELETE(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!isAaspaiWorkspace()) {
    return NextResponse.json({ error: "no aaspai workspace" }, { status: 404 });
  }
  const key = new URL(req.url).searchParams.get("key") ?? "";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return NextResponse.json({ error: "invalid key name" }, { status: 400 });
  }
  await clearEnvValue(key);
  return NextResponse.json({ key, isSet: false });
}
