import { NextResponse } from "next/server";
import { getStateSnapshot } from "@/lib/aaspai";

export const dynamic = "force-dynamic";

export async function GET() {
  const state = await getStateSnapshot();
  return NextResponse.json(state);
}
