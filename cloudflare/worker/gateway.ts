import { API_HEADER, API_LEVEL, APP_HEADER, APP_NAME, PRINCIPAL_HEADER, type Principal } from "../src/protocol";
import { isPageRequest, servePage, type PageDeps } from "./page";
import { asOf, readView, serverTiming, type ViewStore } from "./views";
import { restated } from "../../host/src/lifecycle";
import { currentListing, type RuntimeDeps } from "./runtime-check";
import { connectScript, redeem } from "./connect";

// ---------------------------------------------------------------------------
// The Worker in front: who may do what.
//
// Every request but signing in needs a credential, and nothing is done without
// one. There are two kinds:
//
//   - the owner's session, from POST /auth/login with the owner key the
//     installer wrote once to a file on the owner's machine (stored here as a
//     SHA-256 hash only). It may do everything.
//   - an agent token, which the owner creates. It may create apps, submit,
//     read status and history, fetch a working copy, undo, discard and ask for
//     a preview again. It may not approve or deny a change, confirm going back
//     past a one-way change, or create, list or revoke tokens.
//
// Either may fetch the centre's own CLI and the instructions for a directory
// an agent starts in (GET /starter), so what an agent runs matches this
// centre. Every answer carries the centre's API level (API_HEADER).
//
// Besides signing in, two routes take no credential (worker/connect.ts):
// GET /connect answers the script that connects a directory, which holds
// nothing secret, and POST /connect trades a one-time code the owner made on
// the page for an agent token, counted against guessing as a sign-in is.
//
// The owner page (worker/page.ts) has routes of its own, which take neither
// credential: the owner signs in to it with the owner key and it keeps a
// session of its own in a cookie.
//
// Sessions and tokens are kept hashed by the AuthStore (a Durable Object in
// worker/index.ts). Requests about one app go to that app's Durable Object
// with the principal attached; `GET /apps` is answered from R2 summaries, and
// one app's status and history from its stored view (worker/views.ts), without
// starting a container. This file holds no Cloudflare binding, so its
// rules are tested on their own (test/gateway.test.ts).
// ---------------------------------------------------------------------------

export interface StoredToken {
  readonly id: string;
  readonly label: string;
  readonly created_at: number;
  readonly expires_at: number;
  readonly revoked_at: number | null;
  /** When it last opened a request, to the hour; absent until it is used. */
  readonly last_used_at?: number;
  /** `code`: made by trading a one-time code from the owner page. Absent: made with `token create`. */
  readonly via?: "code";
  /** The agent the CLI detected when it traded the code, e.g. claude-code. */
  readonly agent?: string;
}

/** A one-time code that connects an agent, kept by the SHA-256 of the code. */
export interface StoredCode {
  readonly id: string;
  /** The connection's name, as the owner typed it: the agent token made from the code takes it. */
  readonly label: string;
  readonly created_at: number;
  readonly expires_at: number;
}

/** What became of a code, as the page that made it asks. */
export type CodeState =
  | { readonly state: "waiting"; readonly expires_at: number }
  | { readonly state: "used"; readonly label: string; readonly token_id?: string }
  | { readonly state: "expired" }
  | { readonly state: "gone" };

/** Where sessions and agent tokens live, by the SHA-256 of the secret. Secrets themselves are never stored. */
export interface AuthStore {
  addSession(hash: string, expiresAt: number): Promise<void>;
  hasSession(hash: string, now: number): Promise<boolean>;
  dropSession(hash: string): Promise<void>;
  addToken(hash: string, token: StoredToken): Promise<void>;
  findToken(hash: string, now: number): Promise<StoredToken | null>;
  listTokens(): Promise<StoredToken[]>;
  revokeToken(id: string, now: number): Promise<boolean>;
  /** Failed sign-ins (or wrong codes, under `connect:`) from `key` in the current ten minutes, counting this one when `failed`. */
  loginFailures(key: string, now: number, failed: boolean): Promise<number>;
  /** Keep a code, unless `limit` codes wait already (false then). */
  addCode(hash: string, code: StoredCode, now: number, limit: number): Promise<boolean>;
  /** Take a code, once: it is gone after this call; one past its time gives null. */
  takeCode(hash: string, now: number): Promise<StoredCode | null>;
  /** Note which agent token a used code became. */
  noteCodeToken(id: string, tokenId: string): Promise<void>;
  codeState(id: string, now: number): Promise<CodeState>;
  /** Close a code before it is used. */
  dropCode(id: string): Promise<boolean>;
}

/** One app's Durable Object, as the gateway calls it. */
export interface AppStub {
  fetch(request: Request): Promise<Response>;
}

/** What `token create` writes into the directory an agent starts in, as this centre's build holds it. */
export interface Starter {
  /** The CLI (bin/appgov.mjs) this centre was deployed with. */
  readonly cli: string;
  /** The AGENTS.md block for that directory (overlay/AGENTS.start.md); `{{CENTRE}}` stands for the centre's address. */
  readonly agents: string;
}

export interface GatewayDeps {
  readonly starter: Starter;
  /** SHA-256, hex, of the owner key. */
  readonly ownerKeyHash: string;
  readonly auth: AuthStore;
  readonly app: (name: string) => AppStub;
  /**
   * The Host's own address, as the installer configured it (APPGOV_HOST_URL): the owner's domain when it has one, else
   * its workers.dev address. It is the one the Host tells anyone: the address an agent token is written with, the
   * manager url apps are registered with on PneumaSpace, the origin the owner page's writes must come from. Requests
   * may still come by another address of the same Worker (workers.dev); without this, the address a request came to.
   */
  readonly hostUrl?: string;
  /** Every app's last summary, as the app's Durable Object saved it to R2. `steps` gets how long each R2 read took, in ms. */
  readonly summaries: (steps?: Record<string, number>) => Promise<unknown[]>;
  readonly governance: string;
  readonly now?: () => number;
  /** The owner page's files and what it says about the deployment; without it, the page's routes are not served. */
  readonly page?: PageDeps;
  /** The apps' stored views; without them, every read of an app asks its Durable Object for the view. */
  readonly views?: ViewStore;
  /** Keeps work going after the answer is out (a container started ahead of a decision); without it, none is started. */
  readonly waitUntil?: (work: Promise<unknown>) => void;
  /** The listing of every app on PneumaSpace the reads restate stored facts with (worker/runtime-check.ts); without it, the stored facts alone. */
  readonly runtime?: RuntimeDeps;
}

export const SESSION_PREFIX = "aps_";
export const TOKEN_PREFIX = "apt_";
export const OWNER_KEY_PREFIX = "apk_";
export const SESSION_MS = 12 * 3600_000;
export const LOGIN_FAILURES_ALLOWED = 20;
const MAX_BODY = 48 * 1024 * 1024;
/** What each Durable Object request is: `create` and `write` save the folder afterwards, `read` does not. */
export const OP_HEADER = "x-appgov-op";
/** The Host's own address (hostOrigin), which the Host in the container names as its manager url on PneumaSpace. */
export const ORIGIN_HEADER = "x-appgov-origin";
/** On every API answer: the Host's own address, so a CLI that came by another one (workers.dev) can say where it lives now. */
export const HOST_HEADER = "x-appgov-host";

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomSecret(prefix: string, bytes = 32): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return prefix + [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Equal-length strings compared without stopping at the first difference. */
export function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(`${JSON.stringify(value, null, 2)}\n`, { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}

export const refuse = (status: number, reason: string, error: string) => json({ error, reason }, status);

/**
 * Whether `key` is the owner key, counting a wrong one against `where` (the caller's address): null when it is, the
 * refusal otherwise. The CLI's sign-in and the owner page's share it, and so share the count of wrong keys.
 */
export async function ownerKeyRefusal(deps: GatewayDeps, where: string, key: unknown, now: number): Promise<Response | null> {
  if ((await deps.auth.loginFailures(where, now, false)) >= LOGIN_FAILURES_ALLOWED) return refuse(429, "too_many_attempts", "too many failed sign-ins from here; wait ten minutes");
  const text = typeof key === "string" ? key : "";
  if (!text.startsWith(OWNER_KEY_PREFIX) || !sameText(await sha256(text), deps.ownerKeyHash)) {
    await deps.auth.loginFailures(where, now, true);
    return refuse(401, "wrong_key", "that is not the owner key of this Host");
  }
  return null;
}

async function authenticate(request: Request, deps: GatewayDeps, now: number): Promise<{ principal: Principal; session?: string } | null> {
  const match = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "");
  const secret = match?.[1];
  if (!secret) return null;
  if (secret.startsWith(SESSION_PREFIX) && /^aps_[a-f0-9]{64}$/.test(secret)) {
    const hash = await sha256(secret);
    return (await deps.auth.hasSession(hash, now)) ? { principal: { kind: "owner" }, session: hash } : null;
  }
  if (secret.startsWith(TOKEN_PREFIX) && /^apt_[a-f0-9]{64}$/.test(secret)) {
    const token = await deps.auth.findToken(await sha256(secret), now);
    return token ? { principal: { kind: "agent", id: token.id, label: token.label } } : null;
  }
  return null;
}

async function readText(request: Request): Promise<string> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY) throw new GatewayRefusal(413, "too_large", "request body too large");
  const text = await request.text();
  if (text.length > MAX_BODY) throw new GatewayRefusal(413, "too_large", "request body too large");
  return text;
}

class GatewayRefusal extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

function parseObject(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {}
  throw new GatewayRefusal(400, "bad_json", "request body must be a JSON object");
}

/** The kind of Durable Object operation a request about an app is, or null when no such route exists. */
export function appOperation(method: string, rest: readonly string[]): "read" | "write" | "clear" | "container" | null {
  if (method === "GET" && (rest.length === 0 || (rest.length === 1 && (rest[0] === "history" || rest[0] === "folder")))) return "read";
  if (method === "GET" && rest.length === 2 && rest[0] === "undo-plan") return "read";
  if (method === "POST" && rest.length === 1 && ["changes", "undo", "discard", "take-down", "bring-back", "publish-again"].includes(rest[0]!)) return "write";
  // Clearing ends with the app's objects deleted instead of its folder saved (worker/folders.ts).
  if (method === "POST" && rest.length === 1 && rest[0] === "clear") return "clear";
  if (method === "POST" && rest.length === 3 && rest[0] === "changes" && ["approve", "deny", "preview"].includes(rest[2]!)) return "write";
  if (rest.length === 1 && rest[0] === "container" && method === "GET") return "container";
  if (rest.length === 2 && rest[0] === "container" && rest[1] === "stop" && method === "POST") return "container";
  return null;
}

/** Taking an app down, bringing it back, publishing it again and clearing it: the owner's, never an agent token's. */
const OWNER_LIFECYCLE: Readonly<Record<string, string>> = {
  "take-down": "Taking an app down",
  "bring-back": "Bringing an app back",
  "publish-again": "Publishing an app again",
  clear: "Clearing an app",
};

/** Whether `principal` may make this request about an app; the reason it may not, otherwise. */
export function ownerOnly(rest: readonly string[], body: Record<string, unknown>): string | null {
  if (rest[0] === "changes" && (rest[2] === "approve" || rest[2] === "deny")) return rest[2] === "approve" ? "Approving a change" : "Denying a change";
  if (rest[0] === "undo" && body.accept_one_way === true) return "Going back past a one-way change";
  if (rest[0] === "container") return "Looking at or stopping the Host's container";
  if (rest.length === 1 && OWNER_LIFECYCLE[rest[0]!]) return OWNER_LIFECYCLE[rest[0]!]!;
  return null;
}

/** The Host's own address (GatewayDeps.hostUrl), or the one `url` came to when none is configured. */
export function hostOrigin(deps: GatewayDeps, url: URL): string {
  if (deps.hostUrl) {
    try {
      return new URL(deps.hostUrl).origin;
    } catch {}
  }
  return url.origin;
}

export async function handle(request: Request, deps: GatewayDeps): Promise<Response> {
  let res: Response;
  try {
    res = await route(request, deps);
  } catch (err) {
    res = err instanceof GatewayRefusal ? refuse(err.status, err.reason, err.message) : refuse(500, "internal", err instanceof Error ? err.message : String(err));
  }
  // Every answer, refusals included, says which level of the API this centre speaks, and where the Host lives.
  const answer = new Response(res.body, res);
  answer.headers.set(API_HEADER, String(API_LEVEL));
  answer.headers.set(HOST_HEADER, hostOrigin(deps, new URL(request.url)));
  return answer;
}

async function route(request: Request, deps: GatewayDeps): Promise<Response> {
  const now = deps.now?.() ?? Date.now();
  const url = new URL(request.url);
  const self = hostOrigin(deps, url);
  const method = request.method;
  const parts = url.pathname.split("/").filter(Boolean);

  // The owner page: its views, its files, its sign-in and its writes, none with the API's credentials.
  if (deps.page && isPageRequest(method, url.pathname)) return servePage(request, deps, deps.page, now);

  // Connecting a directory with a one-time code from the owner page: the script, and the trade (worker/connect.ts).
  if (method === "GET" && url.pathname === "/connect") {
    return new Response(connectScript(self, deps.starter.cli), { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  }
  if (method === "POST" && url.pathname === "/connect") return redeem(request, deps, self, now);

  // Takes the owner key and gives a session.
  if (method === "POST" && url.pathname === "/auth/login") {
    const where = request.headers.get("cf-connecting-ip") ?? "unknown";
    const body = parseObject(await readText(request));
    const wrong = await ownerKeyRefusal(deps, where, body.key, now);
    if (wrong) return wrong;
    const session = randomSecret(SESSION_PREFIX);
    const expires = now + SESSION_MS;
    await deps.auth.addSession(await sha256(session), expires);
    return json({ session, expires_at: new Date(expires).toISOString() });
  }

  const who = await authenticate(request, deps, now);
  if (!who) return refuse(401, "unauthenticated", "sign in as the owner, or send an agent token the owner created (Authorization: Bearer ...)");
  const { principal } = who;
  const owner = principal.kind === "owner";

  if (method === "POST" && url.pathname === "/auth/logout") {
    if (who.session) await deps.auth.dropSession(who.session);
    return json({ signed_out: owner });
  }
  if (method === "GET" && url.pathname === "/me") return json({ principal });
  if (method === "GET" && url.pathname === "/starter") {
    return json({ api_level: API_LEVEL, cli: deps.starter.cli, agents: deps.starter.agents.replaceAll("{{CENTRE}}", self), host_url: self });
  }

  if (parts[0] === "tokens") {
    if (!owner) return refuse(403, "owner_required", "only the owner creates, lists and revokes agent tokens");
    if (method === "GET" && parts.length === 1) return json({ tokens: await deps.auth.listTokens() });
    if (method === "POST" && parts.length === 1) {
      const body = parseObject(await readText(request));
      const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 80) : "agent";
      const days = body.expires_in_days === undefined ? 90 : Number(body.expires_in_days);
      if (!Number.isInteger(days) || days < 1 || days > 365) return refuse(400, "bad_expiry", "expires_in_days must be a whole number from 1 to 365");
      const token = randomSecret(TOKEN_PREFIX);
      const stored: StoredToken = { id: `t${randomSecret("", 6)}`, label, created_at: now, expires_at: now + days * 86_400_000, revoked_at: null };
      await deps.auth.addToken(await sha256(token), stored);
      return json({ ...stored, token }, 201);
    }
    if (method === "DELETE" && parts.length === 2) {
      return (await deps.auth.revokeToken(parts[1]!, now)) ? json({ revoked: parts[1] }) : refuse(404, "no_token", `no token ${parts[1]}`);
    }
    return refuse(404, "not_found", "not found");
  }

  if (parts[0] !== "apps") return refuse(404, "not_found", "not found");

  if (parts.length === 1 && method === "GET") {
    // Each summary says what PneumaSpace said when it was saved; a newer listing of all apps restates it, and the answer says when that was.
    const [summaries, check] = await Promise.all([deps.summaries(), currentListing(deps.runtime, { check: url.searchParams.get("check") === "1", ...(deps.waitUntil ? { waitUntil: deps.waitUntil } : {}), ...(deps.now ? { now: deps.now } : {}) })]);
    const apps = summaries.map((s) => (typeof s === "object" && s !== null && typeof (s as { app_id?: unknown }).app_id === "string" ? restated(s as Record<string, unknown>, (s as { app_id: string }).app_id, check.listing) : s));
    return json({ governance: deps.governance, apps, runtime_check: { checked_at: check.listing?.checked_at ?? null, failed: check.failed } });
  }

  if (parts.length === 1 && method === "POST") {
    const text = await readText(request);
    const body = parseObject(text);
    if (typeof body.name !== "string" || !APP_NAME.test(body.name)) return refuse(400, "bad_name", `name must match ${APP_NAME}`);
    return forward(deps, body.name, "create", principal, self, url.pathname, "POST", text);
  }

  const name = parts[1] ?? "";
  if (!APP_NAME.test(name)) return refuse(400, "bad_name", `app name must match ${APP_NAME}`);
  const rest = parts.slice(2);
  const op = appOperation(method, rest);
  if (!op) return refuse(404, "not_found", "not found");
  const text = method === "POST" ? await readText(request) : "";
  const reason = ownerOnly(rest, method === "POST" ? parseObject(text) : {});
  if (reason && !owner) return refuse(403, "owner_required", `${reason} is the owner's decision; an agent token cannot do it`);
  // Status and history, for the owner and agent tokens alike: from the stored view, without a container.
  if (op === "read" && (rest.length === 0 || (rest.length === 1 && rest[0] === "history"))) {
    const steps: Record<string, number> = {};
    const [viewed, check] = await Promise.all([
      readView(deps, name, self, principal, steps),
      rest.length === 0 ? currentListing(deps.runtime, { check: url.searchParams.get("check") === "1", ...(deps.waitUntil ? { waitUntil: deps.waitUntil } : {}), ...(deps.now ? { now: deps.now } : {}), timing: steps }) : null,
    ]);
    // Where the time of a read went, in the Worker: each R2 read, and the container when the stored view was not usable.
    const header = { "server-timing": serverTiming(steps, viewed.ok ? viewed.source : undefined) };
    if (!viewed.ok) return json({ error: viewed.error, reason: viewed.missing ? "no_app" : "host_unavailable" }, viewed.status, header);
    if (rest.length === 1 && viewed.view.history_total > viewed.view.history.length) {
      // The view holds the newest entries only: the whole history is read from the app's folder, as before stored views.
      const at = Date.now();
      const whole = await forward(deps, name, op, principal, self, url.pathname, method, text);
      const out = new Response(whole.body, whole);
      out.headers.set("server-timing", serverTiming({ ...steps, container: Date.now() - at }, "container"));
      return out;
    }
    const timing = { centre: { view: viewed.ms }, view: viewed.source };
    const status = () => ({ ...restated(asOf(viewed.view.status, now), name, check?.listing, true), ...(check?.failed ? { runtime_check_failed: check.failed } : {}), timing });
    return json(rest.length === 0 ? status() : { history: viewed.view.history, timing }, 200, header);
  }
  return forward(deps, name, op, principal, self, url.pathname, method, text);
}

/** A request about app `name`, to its Durable Object, as `principal`; `path` is the Host's route. `extra` adds headers the Worker sets. */
export function forward(deps: GatewayDeps, name: string, op: string, principal: Principal, origin: string, path: string, method: string, body: string, extra: Record<string, string> = {}): Promise<Response> {
  const headers = new Headers({ ...extra, "content-type": "application/json", [PRINCIPAL_HEADER]: JSON.stringify(principal), [APP_HEADER]: name, [OP_HEADER]: op, [ORIGIN_HEADER]: origin });
  return deps.app(name).fetch(new Request(`https://app${path}`, { method, headers, ...(method === "POST" ? { body } : {}) }));
}
