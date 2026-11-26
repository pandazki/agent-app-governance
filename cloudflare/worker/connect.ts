import { json, randomSecret, refuse, sha256, TOKEN_PREFIX, type GatewayDeps, type StoredToken } from "./gateway";

// ---------------------------------------------------------------------------
// Connecting an agent from the owner page, with a one-time code.
//
//   1. The owner, signed in to the page, names the connection (the computer,
//      say) and gets a code: 8 letters and digits, good for ten minutes and
//      one use. Only its SHA-256 is kept (worker/auth-records.ts).
//   2. The page shows one command to give the agent:
//        curl -fsS <Host>/connect | node - <code>
//      GET /connect answers a short script that writes this Host's own CLI to
//      .appgov/appgov.mjs and runs its `connect <code>`.
//   3. The CLI trades the code at POST /connect for an agent token, which
//      goes straight into .appgov/centre.json, then writes AGENTS.md and
//      CLAUDE.md from GET /starter: what `token create --write` leaves.
//
// The token is never on the page or in the chat: only the code is, and it is
// worth nothing once used, once ten minutes have passed, or once the owner
// closes it. Wrong codes count per address and for everyone together, so
// guessing stops long before it could find one. An agent token cannot make a
// code: codes come only from the page's own routes, in the owner's session.
// ---------------------------------------------------------------------------

/** Letters and digits that cannot be read as one another: no 0/O, 1/I/L. */
export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const CODE_LENGTH = 8;
export const CODE_MS = 10 * 60_000;
/** How many codes may wait at once. */
export const CODES_WAITING = 5;
/** Wrong codes allowed in ten minutes: from one address, and from everyone together. */
export const CODE_FAILURES_PER_ADDRESS = 20;
export const CODE_FAILURES_ALL = 200;
/** An agent token made from a code lives as long as one made with `token create`. */
const TOKEN_DAYS = 90;
const MAX_BODY = 4096;
const LABEL_MAX = 40;

/** A new code, uniformly from the alphabet. */
export function makeCode(): string {
  let out = "";
  // 248 is the largest multiple of 31 below 256: bytes from 248 up are dropped, so every letter is as likely.
  while (out.length < CODE_LENGTH) for (const byte of crypto.getRandomValues(new Uint8Array(16))) if (byte < 248 && out.length < CODE_LENGTH) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return out;
}

/** A code as people read it: two groups of four. */
export const showCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

/** A code as typed or pasted (any case, with or without the dash or spaces), or null when it cannot be one. */
export function normalizeCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  return code.length === CODE_LENGTH && [...code].every((c) => CODE_ALPHABET.includes(c)) ? code : null;
}

/** The connection's name as the owner typed it, or null when there is none. */
export function connectionLabel(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const label = input.replace(/\s+/g, " ").trim().slice(0, LABEL_MAX);
  return label ? label : null;
}

/** The one command the agent is given. */
export const connectCommand = (origin: string, code: string) => `curl -fsS ${origin}/connect | node - ${code}`;

/** A new code for a connection named `label`, or null when CODES_WAITING codes wait already. */
export async function createCode(deps: GatewayDeps, label: string, now: number): Promise<{ id: string; code: string; expires_at: number } | null> {
  const code = makeCode();
  const id = `c${randomSecret("", 6)}`;
  const expires = now + CODE_MS;
  const kept = await deps.auth.addCode(await sha256(code), { id, label, created_at: now, expires_at: expires }, now, CODES_WAITING);
  return kept ? { id, code: showCode(code), expires_at: expires } : null;
}

/**
 * POST /connect: a code for an agent token. No credential but the code itself, so it is counted as a sign-in is: wrong
 * codes from one address, and from everyone, are limited per ten minutes. A browser's request is refused, so a page
 * elsewhere cannot spend codes.
 */
export async function redeem(request: Request, deps: GatewayDeps, self: string, now: number): Promise<Response> {
  if (request.headers.get("origin") !== null || request.headers.get("sec-fetch-site") !== null) return refuse(403, "not_for_browsers", "a code is traded by the Host's CLI, not by a web page");
  const where = `connect:${request.headers.get("cf-connecting-ip") ?? "unknown"}`;
  if ((await deps.auth.loginFailures(where, now, false)) >= CODE_FAILURES_PER_ADDRESS || (await deps.auth.loginFailures("connect:*", now, false)) >= CODE_FAILURES_ALL) {
    return refuse(429, "too_many_attempts", "too many wrong codes; wait ten minutes, then ask the owner for a new code");
  }
  const text = await request.text();
  let body: Record<string, unknown> = {};
  try {
    const value = text.length <= MAX_BODY ? (JSON.parse(text) as unknown) : null;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) body = value as Record<string, unknown>;
  } catch {}
  const code = normalizeCode(body.code);
  const found = code ? await deps.auth.takeCode(await sha256(code), now) : null;
  if (!found) {
    await deps.auth.loginFailures(where, now, true);
    await deps.auth.loginFailures("connect:*", now, true);
    return refuse(401, "bad_code", "that code does not connect anything: it is mistyped, used already, closed, or older than ten minutes. Ask the owner for a new one on the owner page.");
  }
  const token = randomSecret(TOKEN_PREFIX);
  const agent = typeof body.agent === "string" && /^[\w .-]{1,40}$/.test(body.agent) ? body.agent : null;
  const stored: StoredToken = { id: `t${randomSecret("", 6)}`, label: found.label, created_at: now, expires_at: now + TOKEN_DAYS * 86_400_000, revoked_at: null, via: "code", ...(agent ? { agent } : {}) };
  await deps.auth.addToken(await sha256(token), stored);
  await deps.auth.noteCodeToken(found.id, stored.id);
  return json({ ...stored, token, host_url: self }, 201);
}

/**
 * GET /connect: the script the command pipes into node. It holds this Host's own CLI and its address, nothing secret.
 * It writes the CLI to .appgov/appgov.mjs in the current directory and runs `connect <code>` with it; when that fails,
 * it takes away what it wrote, so a failed attempt leaves the directory as it was.
 */
export function connectScript(origin: string, cli: string): string {
  return `// Connects the current directory to the appgov Host at ${origin}. Run it as:
//   curl -fsS ${origin}/connect | node - <one-time code from the owner page>
// It writes this Host's own CLI to .appgov/appgov.mjs and runs its connect command, which trades the code for an agent
// token, saved in .appgov/centre.json and never printed, and writes AGENTS.md and CLAUDE.md, which say what this
// directory is and how to work in it. It talks to ${origin} only. If connecting fails, it removes what it wrote.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const HOST = ${JSON.stringify(origin)};
const CLI = ${JSON.stringify(cli)};
const code = process.argv[2];
if (!code) {
  console.error("appgov connect: give the one-time code from the owner page: curl -fsS " + HOST + "/connect | node - <code>");
  process.exit(1);
}
const dir = path.join(process.cwd(), ".appgov");
const file = path.join(dir, "appgov.mjs");
if (fs.existsSync(path.join(dir, "centre.json"))) {
  console.error("appgov connect: " + path.join(dir, "centre.json") + " exists already, so this directory is connected. Nothing was changed. To connect another directory, run the command there.");
  process.exit(1);
}
const hadDir = fs.existsSync(dir);
const hadFile = fs.existsSync(file);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(file, CLI, { mode: 0o755 });
const run = spawnSync(process.execPath, [file, "connect", code, "--host", HOST], { stdio: ["ignore", "inherit", "inherit"] });
if (run.status !== 0) {
  if (!hadDir) fs.rmSync(dir, { recursive: true, force: true });
  else if (!hadFile) fs.rmSync(file, { force: true });
  process.exit(run.status === null ? 1 : run.status);
}
`;
}
