import { NextResponse } from "next/server";
import { listAgents } from "@/lib/aaspai";

export const dynamic = "force-dynamic";

export async function GET() {
  const agents = await listAgents();
  return NextResponse.json({ agents });
}
