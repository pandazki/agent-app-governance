import { VIEW_SCHEMA, type Principal, type StoredPlans, type StoredView } from "../src/protocol";
import { forward, type GatewayDeps } from "./gateway";

// ---------------------------------------------------------------------------
// The reads of one app, answered from its stored view (StoredView in
// src/protocol.ts) without a container: the owner page's views of the app, a
// change that waits and the plan for going back, and the CLI's status and
// history.
//
// The app's Durable Object stores the view after every operation that saved
// the folder (worker/folders.ts). A reader takes it only while it is of this
// Worker's shape (VIEW_SCHEMA) and names the etag the folder has in R2 now.
// When it is missing (an app saved by a build before stored views), of another
// shape (a build that changed it), or names another etag (the folder changed
// and the view could not be stored, or another writer saved over it), the
// reader asks the app's Durable Object once: the container computes the view of
// the folder in R2, the Durable Object stores it, and the reader serves it. The
// next reader finds it stored.
//
// Right after a deploy, an app's Durable Object that is still active runs the
// build before, which has no `view` operation. It refuses it (bad_op), and the
// reader then asks it the reads it has always answered (status and history),
// as before stored views; once it goes idle and restarts on this build, the
// next reader gets a view stored.
//
// The view's size does not grow with the app's age: it carries the newest
// history entries and the plans for going back to the versions nearest the
// current one (HISTORY_KEPT, PLANS_KEPT in src/protocol.ts). A plan for an older
// version is worked out by the container when the owner opens it, kept beside
// the view for that folder (StoredPlans), and taken by the next reader under
// the same rule as the view: only while the folder in R2 has the etag it names.
// ---------------------------------------------------------------------------

/** Where the stored views and the folders' etags are read (R2, in worker/index.ts). */
export interface ViewStore {
  /** The app's stored view as JSON, or null when there is none. */
  view(app: string): Promise<unknown>;
  /** The plans worked out for the app when the owner asked (StoredPlans) as JSON, or null when there are none. */
  plans?(app: string): Promise<unknown>;
  /** The etag of the app's folder in R2, or null when there is no folder. */
  folderEtag(app: string): Promise<string | null>;
}

export type ViewAnswer =
  | { readonly ok: true; readonly view: StoredView; readonly source: "stored" | "container" | "legacy"; readonly ms: number }
  | { readonly ok: false; readonly status: number; readonly missing: boolean; readonly error: string };

/** Whether `value` is a view of `app` of this Worker's shape, and, given an etag, of the folder that has it. */
export function usable(value: unknown, app: string, etag: string | null): value is StoredView {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<StoredView>;
  return (
    v.schema === VIEW_SCHEMA &&
    v.app === app &&
    typeof v.folder_etag === "string" &&
    (etag === null || v.folder_etag === etag) &&
    typeof v.status === "object" &&
    v.status !== null &&
    Array.isArray(v.history) &&
    typeof v.history_total === "number" &&
    typeof v.plans === "object" &&
    v.plans !== null
  );
}

/** The stored view and the folder's etag as R2 has them (the etag null without a folder, undefined when it could not be read). */
export interface Peek {
  readonly stored: unknown;
  readonly etag: string | null | undefined;
}

/** Reads the stored view and the folder's etag from R2 only, side by side: what readView starts with, begun early by a caller that has other reads to make. */
export function peekView(deps: GatewayDeps, app: string, timing: Record<string, number> = {}): Promise<Peek> | null {
  const views = deps.views;
  if (!views) return null;
  const timed = async <T>(name: string, work: Promise<T>): Promise<T> => {
    const at = Date.now();
    try {
      return await work;
    } finally {
      timing[name] = Date.now() - at;
    }
  };
  return Promise.all([timed("r2-view", views.view(app)).catch(() => null), timed("r2-head", views.folderEtag(app)).catch(() => undefined)]).then(([stored, etag]) => ({ stored, etag }));
}

/**
 * The app's view: stored when it is usable, from the container (which then stores it) when it is not. `timing` gets
 * how long each step took, in ms: `r2-view` (reading the stored view), `r2-head` (the folder's etag), `container`
 * (asking the app's Durable Object, when the stored view was not usable), `legacy` (the reads of an object still on the
 * build before).
 */
export async function readView(deps: GatewayDeps, app: string, origin: string, principal: Principal, timing: Record<string, number> = {}, peeked?: Promise<Peek> | null): Promise<ViewAnswer> {
  const began = Date.now();
  const peek = peeked ?? peekView(deps, app, timing);
  if (peek) {
    const { stored, etag } = await peek;
    if (etag === null) return { ok: false, status: 404, missing: true, error: `this Host has no app named ${app}` };
    if (typeof etag === "string" && usable(stored, app, etag)) return { ok: true, view: stored, source: "stored", ms: Date.now() - began };
  }
  try {
    const at = Date.now();
    const res = await forward(deps, app, "view", principal, origin, `/apps/${app}/view`, "GET", "").finally(() => (timing.container = Date.now() - at));
    const value = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok && usable(value, app, null)) return { ok: true, view: value, source: "container", ms: Date.now() - began };
    if (res.status === 400 && value.reason === "bad_op") {
      const old = Date.now();
      return await legacy(deps, app, origin, principal, began).finally(() => (timing.legacy = Date.now() - old));
    }
    return { ok: false, status: res.ok ? 502 : res.status, missing: res.status === 404 && value.reason === "no_app", error: String(value.error ?? `the app's Durable Object answered ${res.status}`) };
  } catch (err) {
    return { ok: false, status: 502, missing: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type PlanAnswer =
  | {
      readonly ok: true;
      readonly plan: Record<string, unknown> | null;
      /** From the view, from the plans kept for this folder, worked out now by the container, or read from an object on the build before. */
      readonly source: "view" | "stored" | "container" | "legacy";
      /** The etag of the folder a plan worked out now is of: the view to show it with is of the same folder. */
      readonly etag?: string;
    }
  | { readonly ok: false; readonly status: number; readonly error: string };

/** The plan kept for `version` in StoredPlans of `app` for the folder with `etag`, null when it was kept as none, undefined when not kept. */
export function keptPlan(value: unknown, app: string, etag: string, version: string): Record<string, unknown> | null | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Partial<StoredPlans>;
  if (v.schema !== VIEW_SCHEMA || v.app !== app || typeof v.folder_etag !== "string" || v.folder_etag !== etag || !Array.isArray(v.plans)) return undefined;
  const found = v.plans.find((entry) => entry?.version === version);
  return found ? (found.plan ?? null) : undefined;
}

/**
 * The plan for going back to `version`, beside `view`: the view's own for the versions nearest the current one; else
 * the one kept for the folder the view is of; else the container works it out now and the app's Durable Object keeps
 * it. `timing` gets `r2-plans` and `plan` (the container), in ms.
 */
export async function readPlan(deps: GatewayDeps, app: string, origin: string, view: StoredView, version: string, timing: Record<string, number> = {}): Promise<PlanAnswer> {
  if (Object.hasOwn(view.plans, version)) return { ok: true, plan: view.plans[version] ?? null, source: "view" };
  const timed = async <T>(name: string, work: Promise<T>): Promise<T> => {
    const at = Date.now();
    try {
      return await work;
    } finally {
      timing[name] = Date.now() - at;
    }
  };
  if (deps.views?.plans && view.folder_etag) {
    const kept = keptPlan(await timed("r2-plans", deps.views.plans(app)).catch(() => null), app, view.folder_etag, version);
    if (kept !== undefined) return { ok: true, plan: kept, source: "stored" };
  }
  // An object still on the build before (its view was put together from the reads it knows, and names no folder):
  // the read it has always answered, kept nowhere.
  // Its plan carries no entries: with a view that holds the newest part of the history only, the whole history is read too.
  const legacy = async (): Promise<PlanAnswer> => {
    const old = await timed("legacy", forward(deps, app, "read", { kind: "owner" }, origin, `/apps/${app}/undo-plan/${version}`, "GET", ""));
    const plan = (await old.json().catch(() => null)) as Record<string, unknown> | null;
    if (!old.ok || !plan) return { ok: true, plan: null, source: "legacy" };
    if (view.history_total <= view.history.length) return { ok: true, plan, source: "legacy" };
    const whole = await forward(deps, app, "read", { kind: "owner" }, origin, `/apps/${app}/history`, "GET", "");
    const history = ((await whole.json().catch(() => ({}))) as { history?: unknown }).history;
    return { ok: true, plan: { ...plan, entries: Array.isArray(history) ? history : [] }, source: "legacy" };
  };
  try {
    if (!view.folder_etag) return await legacy();
    const res = await timed("plan", forward(deps, app, "plan", { kind: "owner" }, origin, `/apps/${app}/undo-plan/${version}`, "GET", ""));
    const value = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok && typeof value.folder_etag === "string") {
      const plan = typeof value.plan === "object" && value.plan !== null ? (value.plan as Record<string, unknown>) : null;
      return { ok: true, plan, source: "container", etag: value.folder_etag };
    }
    if (res.status === 400 && value.reason === "bad_op") return await legacy();
    return { ok: false, status: res.ok ? 502 : res.status, error: String(value.error ?? `the app's Durable Object answered ${res.status}`) };
  } catch (err) {
    return { ok: false, status: 502, error: err instanceof Error ? err.message : String(err) };
  }
}

/** `timing` as a Server-Timing header: each step with its duration, where the view came from, and where a plan for going back did. */
export function serverTiming(timing: Record<string, number>, source?: string, planned?: string): string {
  return [...Object.entries(timing).map(([name, ms]) => `${name};dur=${ms}`), ...(planned ? [`plan-source;desc="${planned}"`] : []), ...(source ? [`source;desc="${source}"`] : [])].join(", ");
}

/** A view put together from the reads a Durable Object of the build before answers; not stored, and without plans (the page asks for a plan when it needs one). */
async function legacy(deps: GatewayDeps, app: string, origin: string, principal: Principal, began: number): Promise<ViewAnswer> {
  const read = async (path: string) => {
    const res = await forward(deps, app, "read", principal, origin, path, "GET", "");
    return { res, value: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const [status, history] = await Promise.all([read(`/apps/${app}`), read(`/apps/${app}/history`)]);
  for (const { res, value } of [status, history]) {
    if (!res.ok) return { ok: false, status: res.status, missing: res.status === 404 && (value.reason === "no_app" || /^no app named/.test(String(value.error ?? ""))), error: String(value.error ?? `answered ${res.status}`) };
  }
  const { timing: _timing, ...answer } = status.value;
  const entries = Array.isArray(history.value.history) ? history.value.history : [];
  const view: StoredView = { schema: VIEW_SCHEMA, app, folder_etag: "", computed_at: new Date().toISOString(), status: answer, history: entries, history_total: entries.length, plans: {} };
  return { ok: true, view, source: "legacy", ms: Date.now() - began };
}

/**
 * The status as of `now`. What PneumaSpace said is as it was when the view was computed, except for what time alone
 * changes: a preview past the end PneumaSpace gave it is gone. Anything else the platform changed since (a preview
 * discarded by hand on PneumaSpace) shows when the owner decides: the decision asks the platform and says so.
 */
export function asOf(status: Record<string, unknown>, now: number): Record<string, unknown> {
  if (!Array.isArray(status.pending)) return status;
  const pending = status.pending.map((p: unknown) => {
    const preview = (p as { preview?: { state?: unknown; app?: unknown; expires_at?: unknown } })?.preview;
    if (preview?.state !== "standing" || typeof preview.expires_at !== "string") return p;
    const ends = Date.parse(preview.expires_at);
    if (!Number.isFinite(ends) || ends > now) return p;
    return { ...(p as object), preview: { state: "gone", app: preview.app, note: `it ended itself at ${preview.expires_at}` } };
  });
  return { ...status, pending };
}

/** Starts the app's container and loads its folder, without waiting for it: for the decision the owner is about to make. */
export function warm(deps: GatewayDeps, app: string, origin: string): void {
  if (!deps.waitUntil) return;
  deps.waitUntil(
    forward(deps, app, "warm", { kind: "owner" }, origin, `/apps/${app}/warm`, "GET", "")
      .then((res) => res.body?.cancel())
      .catch(() => {}),
  );
}
