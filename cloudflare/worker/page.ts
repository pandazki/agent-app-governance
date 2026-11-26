import { appModel, assetType, backModel, changeModel, homeModel, missingModel, NO_PICTURES_HERE, PAGE_ICON, pageHeaders, renderShell, signInModel, unreadableModel, type Overview, type PageContext, type UndoPlanView } from "../../local/src/page-views";
import { asOf, peekView, readPlan, readView, serverTiming, warm, type Peek } from "./views";
import type { PageModel } from "../../local/src/page-model";
import { chooseLang } from "../../local/src/page-words";
import { APP_NAME, CHANNEL_HEADER, OWNER_SUBJECT, PAGE_CHANNEL } from "../src/protocol";
import { forward, json, ownerKeyRefusal, randomSecret, refuse, sameText, SESSION_MS, sha256, type GatewayDeps } from "./gateway";

// ---------------------------------------------------------------------------
// The owner page, served by the Worker: the local edition's page (its views'
// models, its words and its client, local/src/page-views.ts and local/web/),
// behind a sign-in.
//
//   - Without the owner's page session, every view is the sign-in view: one
//     field for the owner key and nothing about the apps. The built client's
//     files are served to anyone; they hold no data.
//   - The right key (checked as the CLI's sign-in checks it, counting wrong
//     keys against the same ten-minute limit per address) gives a session in a
//     cookie: `__Host-` (this origin only, every path), HttpOnly, Secure,
//     SameSite=Strict, for 12 hours. The session is kept hashed beside the
//     CLI's, under a prefix of its own (`apc_`), so neither works as the other.
//   - Every write (sign in, sign out, a decision, going back, a preview again)
//     must come from this origin: `Origin` equal to it, `Sec-Fetch-Site`
//     same-origin when the browser sends it, and a JSON body. A write in a
//     session must also carry the session's own token (`x-appgov-csrf`), which
//     only a view served to that session holds.
//   - Agent tokens and the CLI's sessions are not read here: these routes take
//     no Authorization header at all.
//
// What a view shows comes from R2, without a container: the list of apps from
// the summaries (and their index, worker/apps-index.ts), one app's status,
// newest history and plans for going back to the nearest versions from its
// stored view (worker/views.ts), which the container computes again only when
// it is missing, stale or of another shape. A plan for an older version is
// worked out by the container when it is opened and kept for that folder; the
// whole history of an app that has more is read from its folder. A decision or going back goes
// through the app's Durable Object and container as the owner, marked as made on
// the page; opening a waiting change or a plan starts the container meanwhile,
// so the decision does not also wait for it.
// ---------------------------------------------------------------------------

export interface PageDeps {
  /** A file of the built client (local/web/dist) by its path there, e.g. app.js or fonts/inter-latin-wght-normal.woff2; null when there is none. */
  asset(name: string): Promise<Response | null>;
  /** app.js and app.css, each with a short hash of its content: the page asks for them by it, so a new build is not served from a cache. */
  versions(): Promise<ReadonlyMap<string, string>>;
  /** PneumaSpace's origin: its console, and where the apps open behind PneumaSpace's own sign-in. */
  readonly spaceOrigin?: string;
  /** The name the Host goes by on PneumaSpace as the manager of the apps it releases. */
  readonly manager?: string;
}

export const PAGE_COOKIE = "__Host-appgov-page";
export const PAGE_SESSION_PREFIX = "apc_";
/** The header a write in a session carries the session's own token in. */
export const CSRF_HEADER = "x-appgov-csrf";
const MAX_PAGE_BODY = 16 * 1024;
const DONE = new Set(["live", "live_marked", "no", "back", "back_marked"]);
const VERSION = /^v\d+$/;
const CHANGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Whether a request is one of the page's: its views, its files, and its writes under /owner/. */
export function isPageRequest(method: string, path: string): boolean {
  if (method === "GET") return path === "/" || path.startsWith("/app/") || path.startsWith("/assets/");
  return method === "POST" && path.startsWith("/owner/");
}

/** This session's own token: derived from the session's secret, so only what was served to the session can know it. */
export function csrfToken(session: string): Promise<string> {
  return sha256(`appgov-page-csrf:${session}`);
}

function sessionCookie(value: string, seconds: number): string {
  return `${PAGE_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${seconds}`;
}

/** The page session the request's cookie names, when it is one this Worker keeps and has not ended. */
async function pageSession(request: Request, deps: GatewayDeps, now: number): Promise<string | null> {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at < 0 || part.slice(0, at).trim() !== PAGE_COOKIE) continue;
    const value = part.slice(at + 1).trim();
    if (/^apc_[a-f0-9]{64}$/.test(value) && (await deps.auth.hasSession(await sha256(value), now))) return value;
  }
  return null;
}

/** Why a write may not act, or null: it must come from this origin's own page and say JSON. */
function crossSite(request: Request, origin: string): Response | null {
  const site = request.headers.get("sec-fetch-site");
  if (request.headers.get("origin") !== origin || (site !== null && site !== "same-origin")) return refuse(403, "not_from_this_page", "the owner page's writes come only from the owner page itself");
  const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") return refuse(415, "content_type_required", "a request that changes something must say content-type: application/json");
  return null;
}

async function readObject(request: Request): Promise<Record<string, unknown> | Response> {
  const text = await request.text();
  if (text.length > MAX_PAGE_BODY) return refuse(413, "too_large", "request body too large");
  if (!text.trim()) return {};
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {}
  return refuse(400, "bad_json", "request body must be a JSON object");
}

export async function servePage(request: Request, deps: GatewayDeps, page: PageDeps, now: number): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname.startsWith("/assets/")) return asset(url.pathname.slice("/assets/".length), page);
  const session = await pageSession(request, deps, now);
  if (request.method === "POST") return write(request, url, deps, session, now);
  return view(request, url, deps, page, session);
}

// --- the built client --------------------------------------------------------------------------------------------

async function asset(name: string, page: PageDeps): Promise<Response> {
  if (name === "icon.svg") {
    return new Response(PAGE_ICON, { headers: { "content-type": "image/svg+xml", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "cache-control": "public, max-age=86400" } });
  }
  const type = assetType(name);
  const found = type ? await page.asset(name) : null;
  if (!type || !found || !found.ok) {
    await found?.body?.cancel();
    return new Response("no such file\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" } });
  }
  return new Response(found.body, {
    headers: {
      "content-type": type,
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
      // The page asks for app.js and app.css with their content's hash; fonts never change under one name.
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

// --- views -------------------------------------------------------------------------------------------------------

function nonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}

/** What the app's Durable Object answers to a read, as the owner: the value, or why there is none. */
async function read(deps: GatewayDeps, origin: string, name: string, path: string): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; missing: boolean; error: string }> {
  try {
    const res = await forward(deps, name, "read", { kind: "owner" }, origin, path, "GET", "");
    const value = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok && typeof value === "object" && value !== null) return { ok: true, value };
    return { ok: false, missing: res.status === 404 && (value.reason === "no_app" || /^no app named/.test(String(value.error ?? ""))), error: String(value.error ?? `answered ${res.status}`) };
  } catch (err) {
    return { ok: false, missing: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function view(request: Request, url: URL, deps: GatewayDeps, page: PageDeps, session: string | null): Promise<Response> {
  const tag = nonce();
  const versions = await page.versions();
  // Where a view's time went in the Worker, in its Server-Timing header: the summaries, each R2 read of the stored view.
  const steps: Record<string, number> = {};
  let source: string | undefined;
  let planned: string | undefined;
  const html = (status: number, model: PageModel) =>
    new Response(renderShell(model, tag, { dir: "", files: versions }), { status, headers: { ...pageHeaders(tag), ...(session ? { "server-timing": serverTiming(steps, source, planned) } : {}) } });
  const done = url.searchParams.get("done");
  const parts = url.pathname.split("/").filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return "";
    }
  });
  const name = parts[1] ?? "";
  const shape =
    url.pathname === "/"
      ? null
      : parts.length === 2
        ? "app"
        : parts.length === 3 && parts[2] === "history"
          ? "history"
          : parts.length === 4 && parts[2] === "change" && CHANGE_ID.test(parts[3]!)
            ? "change"
            : parts.length === 4 && parts[2] === "back" && VERSION.test(parts[3]!)
              ? "back"
              : null;
  // One app's stored view is read from R2 beside the summaries; its Durable Object is asked only once the summaries
  // list the app (a made-up name reaches no container).
  const peeked: Promise<Peek> | null = session && shape && APP_NAME.test(name) ? peekView(deps, name, steps) : null;
  const listed = Date.now();
  // A summary saved by a build before summaries named the owner gets the subject every app here is created with.
  const summaries = session
    ? ((await deps.summaries(steps))
        .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null && APP_NAME.test(String((s as { app_id?: unknown }).app_id ?? "")))
        .map((s) => ("error" in s || typeof s.owner === "string" ? s : { ...s, owner: OWNER_SUBJECT })) as unknown as Overview["summaries"])
    : [];
  if (session) steps.summaries = Date.now() - listed;
  const space = page.spaceOrigin ? `${page.spaceOrigin.replace(/\/+$/, "")}/` : undefined;
  const ctx: PageContext = {
    lang: chooseLang(url.searchParams.get("lang"), request.headers.get("accept-language") ?? undefined),
    now: deps.now?.() ?? Date.now(),
    pictures: NO_PICTURES_HERE,
    path: url.pathname,
    apps: summaries,
    ...(session && done && DONE.has(done) ? { done: done as PageContext["done"] } : {}),
    governance: deps.governance,
    dataSnapshot: null,
    hostUrl: url.origin,
    ...(space ? { consoleUrl: space } : {}),
    ...(page.manager ? { manager: page.manager } : {}),
    access: { kind: "session", csrf: session ? await csrfToken(session) : "" },
    appsSignIn: true,
  };
  // Without a session: the sign-in view, whatever was asked for, and nothing else.
  if (!session) return html(401, signInModel(ctx, "/owner/signin"));

  if (url.pathname === "/") {
    const overview: Overview = { governance: deps.governance, governance_note: "", data_snapshot: null, summaries, apps: [], generated_at: new Date(ctx.now).toISOString(), host_url: url.origin, ...(space ? { console_url: space } : {}), ...(page.manager ? { manager: page.manager } : {}) };
    return html(200, homeModel(overview, ctx));
  }
  if (!shape || !APP_NAME.test(name) || !summaries.some((s) => s.app_id === name)) return html(404, missingModel(ctx));

  let viewed = await readView(deps, name, url.origin, { kind: "owner" }, steps, peeked);
  if (viewed.ok) source = viewed.source;
  if (!viewed.ok) return viewed.missing ? html(404, missingModel(ctx)) : html(502, unreadableModel(name, viewed.error, ctx, true));
  // A plan for going back that the view does not carry (an older version): kept for this folder, or worked out now.
  // One worked out for a folder saved after the view was read is shown with the view of that folder.
  const plan = shape === "back" ? await readPlan(deps, name, url.origin, viewed.view, parts[3]!, steps) : null;
  if (plan && !plan.ok) return html(502, unreadableModel(name, plan.error, ctx, true));
  if (plan?.ok) planned = plan.source;
  if (plan?.etag && plan.etag !== viewed.view.folder_etag) {
    const again = await readView(deps, name, url.origin, { kind: "owner" }, {});
    if (again.ok) viewed = again;
  }
  const status = asOf(viewed.view.status, ctx.now);
  const appStatus = status as unknown as Parameters<typeof appModel>[1];
  const kept = viewed.view.history as unknown as Parameters<typeof appModel>[2];
  // The risks this mode's standing rule lets through, as the container reports them with status.
  const withRules: PageContext = { ...ctx, autoApproved: Array.isArray(status.auto_approved) ? (status.auto_approved as string[]) : [] };
  const earlier = viewed.view.history_total - viewed.view.history.length;
  if (shape === "app") return html(200, appModel(name, appStatus, kept, earlier > 0 ? { ...withRules, historyMore: earlier } : withRules));
  if (shape === "history") {
    // The whole history: from the view while it holds all of it, else read from the app's folder.
    if (earlier <= 0) return html(200, appModel(name, appStatus, kept, { ...withRules, historyAll: true }));
    const whole = await read(deps, url.origin, name, `/apps/${name}/history`);
    if (!whole.ok) return whole.missing ? html(404, missingModel(ctx)) : html(502, unreadableModel(name, whole.error, ctx, true));
    source = "container";
    return html(200, appModel(name, appStatus, (Array.isArray(whole.value.history) ? whole.value.history : []) as Parameters<typeof appModel>[2], { ...withRules, historyAll: true }));
  }
  if (shape === "change") {
    const model = changeModel(name, appStatus, parts[3]!, withRules);
    if (!model.gone) warm(deps, name, url.origin);
    return html(200, model);
  }
  // A version the Host would not plan (not one the current version was built on): the page says it cannot go back there.
  const version = parts[3]!;
  const found = plan?.ok ? plan.plan : null;
  const planView: UndoPlanView | null = found ? { ...(found as unknown as UndoPlanView), dataLeft: (found.data_left as UndoPlanView["dataLeft"]) ?? null } : null;
  // A plan carries the entries it needs that are older than the view's history (each version from the current one down
  // to it), in the history's order; one from an object on the build before carries none, and its view has them all.
  const entries = Array.isArray(found?.entries) ? ([...found.entries, ...kept] as Parameters<typeof backModel>[2]) : kept;
  const model = backModel(name, appStatus, entries, version, planView, withRules);
  if (model.kind === "plan") warm(deps, name, url.origin);
  return html(200, model);
}

// --- writes ------------------------------------------------------------------------------------------------------

async function write(request: Request, url: URL, deps: GatewayDeps, session: string | null, now: number): Promise<Response> {
  const refused = crossSite(request, url.origin);
  if (refused) return refused;
  const input = await readObject(request);
  if (input instanceof Response) return input;
  const parts = url.pathname.split("/").filter(Boolean);

  if (parts.length === 2 && parts[1] === "signin") {
    const wrong = await ownerKeyRefusal(deps, request.headers.get("cf-connecting-ip") ?? "unknown", input.key, now);
    if (wrong) return wrong;
    if (session) await deps.auth.dropSession(await sha256(session));
    const fresh = randomSecret(PAGE_SESSION_PREFIX);
    await deps.auth.addSession(await sha256(fresh), now + SESSION_MS);
    return json({ signed_in: true, expires_at: new Date(now + SESSION_MS).toISOString() }, 200, { "set-cookie": sessionCookie(fresh, SESSION_MS / 1000) });
  }

  if (!session) return json({ error: "sign in to the owner page first", reason: "signed_out" }, 401, { "set-cookie": sessionCookie("", 0) });
  if (!sameText(request.headers.get(CSRF_HEADER) ?? "", await csrfToken(session))) {
    return refuse(403, "not_from_this_page", "this request does not carry the owner page's token for this session; reload the page");
  }

  if (parts.length === 2 && parts[1] === "signout") {
    await deps.auth.dropSession(await sha256(session));
    return json({ signed_out: true }, 200, { "set-cookie": sessionCookie("", 0) });
  }

  const name = parts[2] ?? "";
  if (parts[1] !== "apps" || !APP_NAME.test(name)) return refuse(404, "not_found", "not found");
  const reason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim().slice(0, 500) : undefined;
  const asOwner = (path: string, body: Record<string, unknown>) =>
    forward(deps, name, "write", { kind: "owner" }, url.origin, path, "POST", JSON.stringify(body), { [CHANNEL_HEADER]: PAGE_CHANNEL });
  let res: Response;
  if (parts.length === 6 && parts[3] === "changes" && CHANGE_ID.test(parts[4]!) && ["approve", "deny", "preview"].includes(parts[5]!)) {
    res = await asOwner(`/apps/${name}/changes/${parts[4]}/${parts[5]}`, parts[5] === "deny" && reason ? { reason } : {});
  } else if (parts.length === 4 && parts[3] === "undo") {
    if (typeof input.to !== "string" || !VERSION.test(input.to)) return refuse(400, "bad_version", "to must be a version name, e.g. v3");
    // Going back is tied to the plan the page showed: the version it started from comes with the click.
    if (typeof input.from !== "string" || !VERSION.test(input.from)) return refuse(400, "bad_version", "from must be the version the plan started from, e.g. v5");
    res = await asOwner(`/apps/${name}/undo`, { reason: reason ?? "undo", to: input.to, from: input.from, accept_one_way: input.accept_one_way === true });
  } else {
    return refuse(404, "not_found", "not found");
  }
  // The Host's answer, without the working copy it sends the CLI: the page has no use for the app's files.
  const text = await res.text();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return refuse(502, "host_unavailable", text.slice(0, 300) || `the Host answered ${res.status}`);
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const { working_copy: _files, ...rest } = value as Record<string, unknown>;
    value = rest;
  }
  return json(value, res.status);
}
