import { FOLDER_HEADER, folderKey, PLANS_KEPT, plansKey, summaryKey, TIMING_HEADER, VIEW_SCHEMA, viewKey, type StoredPlans } from "../src/protocol";
import { putInIndex } from "./apps-index";

// ---------------------------------------------------------------------------
// One operation on one app, as its Durable Object runs it.
//
// R2 holds the record: each app's folder as one tar object. The container's
// disk is a cache that may be gone at any moment, so every operation starts
// from R2 and every operation that wrote ends in R2:
//
//   1. Read the folder's object and its etag (none yet for a create).
//   2. Ask the Host. The request names the etag; a container that does not
//      hold that folder (new, restarted, or behind) says so, gets the tar, and
//      the request is sent again.
//   3. After a create or a write, take the folder back as a tar and put it with
//      a condition: only over the etag read in 1 (only where nothing is, for a
//      create). If another writer got there first, nothing is overwritten, the
//      container forgets its copy, and the caller is told.
//   4. Keep a small summary next to it, which `GET /apps` reads without a
//      container (and the same summary in the index of all of them,
//      worker/apps-index.ts), and the app's stored view (StoredView in
//      src/protocol.ts), which the Worker answers the reads of one app from
//      (worker/views.ts). The view names the etag of the folder it was
//      computed from, so a reader can tell when it describes another folder
//      than the one in R2.
//
// Three more operations serve the reads: `view` has the container compute the
// view of the folder in R2 and stores it (when the stored one is missing,
// stale or of another shape); `plan` has it work out one plan for going back
// that the view does not carry and keeps it beside the view, for that folder
// (StoredPlans); and `warm` only starts the container and loads the folder, so
// a decision the owner is about to make does not wait for that.
//
// The Durable Object runs one operation at a time for its app; the condition
// in 3 still holds if two ever ran. No Cloudflare binding here: the bucket and
// the container are interfaces, so tests run this with fakes.
// ---------------------------------------------------------------------------

export interface StoredObject {
  readonly etag: string;
  bytes(): Promise<ArrayBuffer>;
}

/** The part of an R2 bucket this needs. `put` resolves to null when its condition fails, as R2's does. */
export interface FolderBucket {
  get(key: string): Promise<StoredObject | null>;
  put(key: string, value: ArrayBuffer | string, condition?: { etagMatches?: string; etagDoesNotMatch?: string }): Promise<{ etag: string } | null>;
  /** Every object whose key starts with `prefix`, with its etag. */
  list(prefix: string): Promise<{ key: string; etag: string }[]>;
}

/** The Host in the app's container. The caller adds the shared secret. */
export interface HostPort {
  fetch(path: string, init: { method: string; headers?: Record<string, string>; body?: ArrayBuffer | string }): Promise<Response>;
}

export interface Operation {
  readonly app: string;
  readonly op: "create" | "read" | "write" | "view" | "warm" | "plan";
  readonly method: string;
  /** The Host's route, e.g. /apps/todo/changes. */
  readonly path: string;
  /** Headers for the Host: the principal and the app. */
  readonly headers: Record<string, string>;
  readonly body?: string;
}

/** Refusals that come before anything is written: no folder is saved after them. */
const NOTHING_WRITTEN = new Set([400, 401, 403, 404, 412, 413, 415]);

function answer(value: unknown, status: number): Response {
  return new Response(`${JSON.stringify(value)}\n`, { status, headers: { "content-type": "application/json" } });
}

export async function operate(bucket: FolderBucket, host: HostPort, op: Operation, timing: Record<string, number> = {}): Promise<Response> {
  const key = folderKey(op.app);
  const clock = () => Date.now();
  let at = clock();
  const lap = (name: string) => {
    const now = clock();
    timing[name] = (timing[name] ?? 0) + (now - at);
    at = now;
  };

  const stored = await bucket.get(key);
  if (op.op === "create" && stored) return answer({ error: `this Host already has an app named ${op.app}; pick another name`, reason: "exists" }, 409);
  if (op.op !== "create" && !stored) return answer({ error: `this Host has no app named ${op.app}`, reason: "no_app" }, 404);
  const etag = stored?.etag ?? "none";

  // `plan` is asked as GET /apps/<app>/undo-plan/<version>.
  const version = op.op === "plan" ? (/^\/apps\/[^/]+\/undo-plan\/(v\d+)$/.exec(op.path)?.[1] ?? null) : null;
  if (op.op === "plan" && !version) return answer({ error: "to must be a version name, e.g. v3", reason: "bad_version" }, 400);
  const own = op.op === "view" ? `/folder/view?app=${op.app}` : op.op === "warm" ? `/folder/check?app=${op.app}` : op.op === "plan" ? `/folder/plan?app=${op.app}&to=${version}` : null;
  const ask = () =>
    host.fetch(own ?? op.path, { method: own ? "GET" : op.method, headers: { ...op.headers, [FOLDER_HEADER]: etag, "content-type": "application/json" }, ...(!own && op.body !== undefined ? { body: op.body } : {}) });
  let res = await ask();
  if (res.status === 412 && stored) {
    await res.body?.cancel();
    const loaded = await host.fetch(`/folder/load?app=${op.app}`, { method: "POST", headers: { [FOLDER_HEADER]: etag, "content-type": "application/x-tar" }, body: await stored.bytes() });
    if (!loaded.ok) return answer({ error: `the container could not load the folder of ${op.app}: ${(await loaded.text()).slice(0, 300)}`, reason: "load_failed" }, 502);
    lap("load");
    res = await ask();
  }
  const text = await res.text();
  lap("op");
  if (op.op === "view" && res.ok) {
    await bucket.put(viewKey(op.app), text);
    lap("save");
  }
  if (op.op === "plan" && res.ok) {
    await keepPlan(bucket, op.app, safeJson(text) as { folder_etag?: unknown; version?: unknown; plan?: unknown });
    lap("save");
  }
  if (op.op === "view" || op.op === "warm" || op.op === "plan") return withTiming(new Response(op.op === "warm" ? null : text, { status: res.status, headers: { "content-type": "application/json" } }), timing);
  if (op.op === "read" || NOTHING_WRITTEN.has(res.status)) return withTiming(new Response(withCentre(text, timing), { status: res.status, headers: { "content-type": "application/json" } }), timing);

  const saved = await host.fetch(`/folder/save?app=${op.app}`, { method: "POST" });
  if (saved.status === 204) return withTiming(new Response(withCentre(text, timing), { status: res.status, headers: { "content-type": "application/json" } }), timing);
  if (!saved.ok) return answer({ error: `the operation ran, but its folder could not be taken from the container: ${(await saved.text()).slice(0, 300)}`, reason: "save_failed", result: safeJson(text) }, 500);
  const tar = await saved.arrayBuffer();
  const put = await bucket.put(key, tar, stored ? { etagMatches: stored.etag } : { etagDoesNotMatch: "*" });
  if (!put) {
    await host.fetch(`/folder/forget?app=${op.app}`, { method: "POST" });
    return answer(
      {
        error: `the record of ${op.app} changed in R2 while this operation ran, so its result was not saved over it. What the operation did on PneumaSpace is in "result"; run status and history before going on.`,
        reason: "record_conflict",
        result: safeJson(text),
      },
      409,
    );
  }
  await host.fetch(`/folder/saved?app=${op.app}&etag=${encodeURIComponent(put.etag)}`, { method: "POST" });
  const summary = await host.fetch(`/folder/summary?app=${op.app}`, { method: "GET" });
  if (summary.ok) {
    const body = await summary.text();
    const put = await bucket.put(summaryKey(op.app), body);
    if (put) await putInIndex(bucket, op.app, { etag: put.etag, summary: safeJson(body) as Record<string, unknown> });
  } else await summary.body?.cancel();
  lap("save");
  // The view of the folder just saved, timed on its own (`view`). If it cannot be had, the one stored before names the
  // older folder's etag, and the next reader asks for a new one.
  const view = await host.fetch(`/folder/view?app=${op.app}`, { method: "GET", headers: { [FOLDER_HEADER]: put.etag } });
  if (view.ok) await bucket.put(viewKey(op.app), await view.text());
  else await view.body?.cancel();
  lap("view");
  return withTiming(new Response(withCentre(text, timing), { status: res.status, headers: { "content-type": "application/json" } }), timing);
}

/**
 * A plan the owner asked for, kept beside the view for the folder it was worked out from: with the others asked for
 * that folder (the last PLANS_KEPT), or alone when those were for another folder. One app's Durable Object runs one
 * operation at a time, so nothing else writes this object meanwhile.
 */
async function keepPlan(bucket: FolderBucket, app: string, answer: { folder_etag?: unknown; version?: unknown; plan?: unknown }): Promise<void> {
  if (typeof answer.folder_etag !== "string" || typeof answer.version !== "string") return;
  const found = await bucket.get(plansKey(app));
  let kept: StoredPlans["plans"] = [];
  if (found) {
    try {
      const value = JSON.parse(new TextDecoder().decode(await found.bytes())) as Partial<StoredPlans>;
      if (value.schema === VIEW_SCHEMA && value.app === app && value.folder_etag === answer.folder_etag && Array.isArray(value.plans)) kept = value.plans;
    } catch {}
  }
  const plan = typeof answer.plan === "object" && answer.plan !== null ? (answer.plan as Record<string, unknown>) : null;
  const plans = [...kept.filter((entry) => entry.version !== answer.version), { version: answer.version, plan }].slice(-PLANS_KEPT);
  const next: StoredPlans = { schema: VIEW_SCHEMA, app, folder_etag: answer.folder_etag, plans };
  await bucket.put(plansKey(app), JSON.stringify(next));
}

/** The Host's answer with the Durable Object's own steps beside the Host's: `timing.centre`, in ms. */
function withCentre(text: string, timing: Record<string, number>): string {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return text;
    const answer = value as { timing?: Record<string, unknown> };
    return JSON.stringify({ ...answer, timing: { ...(answer.timing ?? {}), centre: { ...timing } } });
  } catch {
    return text;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 2000);
  }
}

export function withTiming(res: Response, timing: Record<string, number>): Response {
  const out = new Response(res.body, res);
  out.headers.set(TIMING_HEADER, Object.entries(timing).map(([k, v]) => `${k}=${v}`).join(";"));
  return out;
}
