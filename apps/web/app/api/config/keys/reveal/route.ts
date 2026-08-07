import { NextResponse } from "next/server";
import { isAaspaiWorkspace } from "@/lib/aaspai";
import { getEnvValue } from "@/lib/env-file";
import { currentUser } from "@/lib/local-auth";

export const dynamic = "force-dynamic";

/** `POST /api/config/keys/reveal` — return a key's full value (once). */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!isAaspaiWorkspace()) {
    return NextResponse.json({ error: "no aaspai workspace" }, { status: 404 });
  }
  let body: { key?: unknown };
  try {
    body = (await req.json()) as { key?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return NextResponse.json({ error: "invalid key name" }, { status: 400 });
  }
  const value = await getEnvValue(key);
  if (value === null) {
    return NextResponse.json({ error: `key ${key} is not set` }, { status: 404 });
  }
  return NextResponse.json({ key, value });
}
