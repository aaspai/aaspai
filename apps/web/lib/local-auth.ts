import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cookies } from "next/headers";
import { workspaceRoot } from "./aaspai";

const COOKIE = "aaspai_session";
const SESSION_DAYS = 30;

interface LocalUser {
  id: string;
  name: string;
  email: string;
  salt: string;
  passwordHash: string;
  organizationId: string;
  companyName: string;
}

interface LocalSession {
  token: string;
  userId: string;
  expiresAt: string;
}

interface AuthState {
  users: LocalUser[];
  sessions: LocalSession[];
}

function statePath(): string {
  return join(workspaceRoot(), ".aaspai", "web-auth.json");
}

async function loadState(): Promise<AuthState> {
  try {
    const parsed = JSON.parse(await readFile(statePath(), "utf8")) as Partial<AuthState>;
    return { users: parsed.users ?? [], sessions: parsed.sessions ?? [] };
  } catch {
    return { users: [], sessions: [] };
  }
}

async function saveState(state: AuthState): Promise<void> {
  await mkdir(join(workspaceRoot(), ".aaspai"), { recursive: true });
  await writeFile(statePath(), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 32).toString("hex");
}

function organizationId(companyName: string): string {
  const slug = companyName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `org_${slug || randomUUID().slice(0, 8)}`;
}

export async function signup(input: {
  name: string;
  email: string;
  password: string;
  companyName: string;
}): Promise<{ user: LocalUser; token: string }> {
  const state = await loadState();
  const email = input.email.trim().toLowerCase();
  if (state.users.some((user) => user.email === email))
    throw new Error("Email is already registered");
  const salt = randomBytes(16).toString("hex");
  const user: LocalUser = {
    id: `user_${randomUUID()}`,
    name: input.name.trim(),
    email,
    salt,
    passwordHash: hashPassword(input.password, salt),
    organizationId: organizationId(input.companyName),
    companyName: input.companyName.trim(),
  };
  const token = await createSession(state, user);
  state.users.push(user);
  await saveState(state);
  return { user, token };
}

export async function login(
  emailInput: string,
  password: string,
): Promise<{ user: LocalUser; token: string }> {
  const state = await loadState();
  const user = state.users.find((candidate) => candidate.email === emailInput.trim().toLowerCase());
  if (!user) throw new Error("Invalid email or password");
  const expected = Buffer.from(user.passwordHash, "hex");
  const actual = Buffer.from(hashPassword(password, user.salt), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("Invalid email or password");
  }
  const token = await createSession(state, user);
  await saveState(state);
  return { user, token };
}

async function createSession(state: AuthState, user: LocalUser): Promise<string> {
  const token = randomBytes(32).toString("hex");
  state.sessions = state.sessions.filter((session) => new Date(session.expiresAt) > new Date());
  state.sessions.push({
    token,
    userId: user.id,
    expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString(),
  });
  return token;
}

export async function currentUser(): Promise<LocalUser | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const state = await loadState();
  const session = state.sessions.find(
    (candidate) => candidate.token === token && new Date(candidate.expiresAt) > new Date(),
  );
  return session ? (state.users.find((user) => user.id === session.userId) ?? null) : null;
}

export function setSessionCookie(response: Response, token: string): void {
  response.headers.append(
    "Set-Cookie",
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`,
  );
}

export function clearSessionCookie(response: Response): void {
  response.headers.append("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export type { LocalUser };
