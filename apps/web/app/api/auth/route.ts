import { NextResponse } from "next/server";
import { clearSessionCookie, login, setSessionCookie, signup } from "@/lib/local-auth";
import { ensureFrontendWorkspace } from "@/lib/workspace-bootstrap";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const action = body?.action;
  try {
    if (action === "signup") {
      if (!body) return NextResponse.json({ error: "Request body is required" }, { status: 400 });
      const fields = ["name", "email", "password", "companyName"];
      if (
        fields.some((field) => typeof body?.[field] !== "string" || !String(body[field]).trim())
      ) {
        return NextResponse.json(
          { error: "Name, email, password, and company are required" },
          { status: 400 },
        );
      }
      const result = await signup({
        name: body.name as string,
        email: body.email as string,
        password: body.password as string,
        companyName: body.companyName as string,
      });
      await ensureFrontendWorkspace(result.user.companyName);
      const response = NextResponse.json(
        { data: { user: { name: result.user.name, email: result.user.email } } },
        { status: 201 },
      );
      setSessionCookie(response, result.token);
      return response;
    }
    if (action === "login") {
      if (typeof body?.email !== "string" || typeof body?.password !== "string") {
        return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
      }
      const result = await login(body.email, body.password);
      const response = NextResponse.json({
        data: { user: { name: result.user.name, email: result.user.email } },
      });
      setSessionCookie(response, result.token);
      return response;
    }
    if (action === "logout") {
      const response = NextResponse.json({ data: { ok: true } });
      clearSessionCookie(response);
      return response;
    }
    return NextResponse.json({ error: "Unknown auth action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Authentication failed" },
      { status: 400 },
    );
  }
}
