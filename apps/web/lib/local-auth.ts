import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cookies } from "next/headers";
import { atomicWriteFile } from "@/lib/atomic-write";
import { workspaceRoot } from "./aaspai";

const COOKIE = "aaspai_session";
const SESSION_DAYS = 30;

// Brute-force protection for the local sign-in. In-process attempt
// tracker (matches the self-hosted single-instance deployment): after
// MAX_FAILED_ATTEMPTS failures within the WINDOW, the (email, ip) pair
// is refused for the remainder of the window. This is a session-level
// guard; a distributed deployment would use the durable login_attempt
// table instead.
const LOGIN_WINDOW_MS = 15 * 60_000;
const MAX_FAILED_ATTEMPTS = 10;

interface AttemptRecord {
  failures: number;
  windowStart: number;
}

const loginAttempts = new Map<string, AttemptRecord>();

function attemptKey(email: string, ip: string): string {
  return `${email.trim().toLowerCase()}\u0000${ip}`;
}

function checkLockout(email: string, ip: string): void {
  const now = Date.now();
  const record = loginAttempts.get(attemptKey(email, ip));
  if (!record) return;
  if (now - record.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.delete(attemptKey(email, ip));
    return;
  }
  if (record.failures >= MAX_FAILED_ATTEMPTS) {
    throw new Error("Too many failed attempts. Try again in a few minutes.");
  }
}

function recordFailure(email: string, ip: string): void {
  const now = Date.now();
  const key = attemptKey(email, ip);
  const current = loginAttempts.get(key);
  if (!current || now - current.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { failures: 1, windowStart: now });
    return;
  }
  current.failures += 1;
}

function recordSuccess(email: string, ip: string): void {
  loginAttempts.delete(attemptKey(email, ip));
}

// Serialize all auth-file writes so concurrent requests (parallel
// signup/login from multiple tabs) can't interleave read-modify-write and
// last-write-wins a session away.
let writeQueue: Promise<unknown> = Promise.resolve();
function enqueueWrite(state: AuthState): Promise<void> {
  const run = async () => {
    await atomicWriteFile(statePath(), `${JSON.stringify(state, null, 2)}\n`);
  };
  const next = writeQueue.then(run, run);
  writeQueue = next.catch(() => undefined);
  return next;
}

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
  await enqueueWrite(state);
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 32).toString("hex");
}

export async function signup(input: {
  name: string;
  email: string;
  password: string;
  companyName: string;
}): Promise<{ user: LocalUser; token: string }> {
  const state = await loadState();
  if (state.users.length > 0) {
    throw new Error("This local workspace already has an owner");
  }
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
    organizationId: "default",
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
  ip = "local",
): Promise<{ user: LocalUser; token: string }> {
  checkLockout(emailInput, ip);
  const state = await loadState();
  const user = state.users.find((candidate) => candidate.email === emailInput.trim().toLowerCase());
  if (!user) {
    recordFailure(emailInput, ip);
    throw new Error("Invalid email or password");
  }
  const expected = Buffer.from(user.passwordHash, "hex");
  const actual = Buffer.from(hashPassword(password, user.salt), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    recordFailure(emailInput, ip);
    throw new Error("Invalid email or password");
  }
  recordSuccess(emailInput, ip);
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
