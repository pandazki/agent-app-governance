import { VIEW_SCHEMA, type Principal, type StoredView } from "../src/protocol";
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
// ---------------------------------------------------------------------------

/** Where the stored views and the folders' etags are read (R2, in worker/index.ts). */
export interface ViewStore {
  /** The app's stored view as JSON, or null when there is none. */
  view(app: string): Promise<unknown>;
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
    typeof v.plans === "object" &&
    v.plans !== null
  );
}

/**
 * The app's view: stored when it is usable, from the container (which then stores it) when it is not. `timing` gets
 * how long each step took, in ms: `r2-view` (reading the stored view), `r2-head` (the folder's etag), `container`
 * (asking the app's Durable Object, when the stored view was not usable).
 */
export async function readView(deps: GatewayDeps, app: string, origin: string, principal: Principal, timing: Record<string, number> = {}): Promise<ViewAnswer> {
  const began = Date.now();
  const timed = async <T>(name: string, work: Promise<T>): Promise<T> => {
    const at = Date.now();
    try {
      return await work;
    } finally {
      timing[name] = Date.now() - at;
    }
  };
  if (deps.views) {
    const [stored, etag] = await Promise.all([timed("r2-view", deps.views.view(app)).catch(() => null), timed("r2-head", deps.views.folderEtag(app)).catch(() => undefined)]);
    if (etag === null) return { ok: false, status: 404, missing: true, error: `this Host has no app named ${app}` };
    if (typeof etag === "string" && usable(stored, app, etag)) return { ok: true, view: stored, source: "stored", ms: Date.now() - began };
  }
  try {
    const res = await timed("container", forward(deps, app, "view", principal, origin, `/apps/${app}/view`, "GET", ""));
    const value = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok && usable(value, app, null)) return { ok: true, view: value, source: "container", ms: Date.now() - began };
    if (res.status === 400 && value.reason === "bad_op") return legacy(deps, app, origin, principal, began);
    return { ok: false, status: res.ok ? 502 : res.status, missing: res.status === 404 && value.reason === "no_app", error: String(value.error ?? `the app's Durable Object answered ${res.status}`) };
  } catch (err) {
    return { ok: false, status: 502, missing: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** `timing` as a Server-Timing header: each step with its duration, and where the view came from. */
export function serverTiming(timing: Record<string, number>, source?: string): string {
  return [...Object.entries(timing).map(([name, ms]) => `${name};dur=${ms}`), ...(source ? [`source;desc="${source}"`] : [])].join(", ");
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
  const view: StoredView = { schema: VIEW_SCHEMA, app, folder_etag: "", computed_at: new Date().toISOString(), status: answer, history: Array.isArray(history.value.history) ? history.value.history : [], plans: {} };
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
