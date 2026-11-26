import type { RuntimeListing } from "../../host/src/lifecycle";

// ---------------------------------------------------------------------------
// Whether the apps are there, for the reads the Worker answers from stored
// views and summaries.
//
// What a stored view or summary says about PneumaSpace (`runtime`, with
// `checked_at`) is what the container saw when it wrote it: at every create,
// write and view it asks PneumaSpace about the app. Between writes an app can
// be removed or purged on PneumaSpace behind the Host's back, so the Worker
// also keeps one listing of every app the plane holds for this Host's tenant
// (one call for all apps), in R2 beside the views (RUNTIME_KEY):
//
//   - a read of the page, the list or status that finds the listing older than
//     RUNTIME_FRESH_MS asks for a new one meanwhile (waitUntil), and is
//     answered with the one it has;
//   - the page's "Check now" (`?check=1`), and the CLI's `--check`, wait for a
//     new one;
//   - one isolate asks the plane once at a time.
//
// The newer of the two facts wins for each app (host/src/lifecycle.ts
// `restated`), and the page and the CLI say when it was confirmed. Nothing is
// done on these facts: every take down, bring back, publish again, clear,
// submit and undo asks PneumaSpace itself, in the container.
// ---------------------------------------------------------------------------

export const RUNTIME_KEY = "runtime.json";
/** A listing older than this is asked for again, without waiting, by the next read. */
export const RUNTIME_FRESH_MS = 5 * 60_000;

export interface RuntimeDeps {
  /** The listing kept in R2, as JSON, or null. */
  read(): Promise<unknown>;
  /** Every app the plane holds for the tenant now: name to status. Throws when the plane does not answer. */
  list(): Promise<Record<string, string>>;
  /** Keeps a new listing in R2. */
  write(listing: RuntimeListing): Promise<void>;
}

export function usableListing(value: unknown): value is RuntimeListing {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<RuntimeListing>;
  return typeof v.checked_at === "string" && Number.isFinite(Date.parse(v.checked_at)) && typeof v.apps === "object" && v.apps !== null && !Array.isArray(v.apps);
}

/** The listing being asked for in this isolate, so concurrent reads ask the plane once. */
let asking: Promise<RuntimeListing> | null = null;

/** Asks the plane for a new listing and keeps it. Rejects with the plane's error when it does not answer. */
export function checkRuntime(deps: RuntimeDeps, now: () => number = Date.now): Promise<RuntimeListing> {
  asking ??= (async () => {
    const apps = await deps.list();
    const listing: RuntimeListing = { checked_at: new Date(now()).toISOString(), apps };
    await deps.write(listing);
    return listing;
  })().finally(() => {
    asking = null;
  });
  return asking;
}

export interface Listing {
  readonly listing: RuntimeListing | null;
  /** Why a check asked for now (`check`) did not answer: the page and the CLI say so beside the older facts. */
  readonly failed: string | null;
}

/**
 * The listing to restate the stored facts with: a new one when `check` asks for it (the page's "Check now"), else the
 * one kept, with a new one asked for meanwhile when it is older than RUNTIME_FRESH_MS. `timing.runtime` gets the time.
 */
export async function currentListing(deps: RuntimeDeps | undefined, options: { readonly check: boolean; readonly waitUntil?: (work: Promise<unknown>) => void; readonly now?: () => number; readonly timing?: Record<string, number> }): Promise<Listing> {
  if (!deps) return { listing: null, failed: null };
  const now = options.now ?? Date.now;
  const began = Date.now();
  const done = (listing: Listing) => {
    if (options.timing) options.timing.runtime = Date.now() - began;
    return listing;
  };
  const kept = await deps.read().then((value) => (usableListing(value) ? value : null)).catch(() => null);
  if (options.check) {
    try {
      return done({ listing: await checkRuntime(deps, now), failed: null });
    } catch (err) {
      return done({ listing: kept, failed: err instanceof Error ? err.message : String(err) });
    }
  }
  if ((!kept || now() - Date.parse(kept.checked_at) > RUNTIME_FRESH_MS) && options.waitUntil) options.waitUntil(checkRuntime(deps, now).catch(() => {}));
  return done({ listing: kept, failed: null });
}

/** The plane's listing for the token's tenant: what CfSpace (src/space-cf.ts) lists, from the Worker. */
export async function planeListing(origin: string, token: string, fetcher: typeof fetch = fetch): Promise<Record<string, string>> {
  const api = async <T>(path: string): Promise<T> => {
    const res = await fetcher(`${origin.replace(/\/+$/, "")}/api/v1${path}`, { headers: { authorization: `Bearer ${token}` }, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`PneumaSpace answered ${res.status} to ${path.startsWith("/me") ? "GET /me" : "the list of apps"}`);
    }
    return (await res.json()) as T;
  };
  const me = await api<{ tenants?: { id?: string }[] }>("/me");
  const tenant = me.tenants?.[0]?.id;
  if (!tenant) throw new Error("the PneumaSpace token belongs to no tenant");
  const listed = await api<{ items?: { name?: unknown; status?: unknown }[] } & Record<string, unknown>>(`/tenants/${encodeURIComponent(tenant)}/apps`);
  // A listing of one page among more would make every app on the others look gone: refuse it, and say nothing new.
  if (["next_cursor", "nextCursor", "cursor", "next"].some((key) => Boolean(listed[key]))) throw new Error("PneumaSpace's list of apps has more than one page, which this Host does not read");
  const apps: Record<string, string> = {};
  for (const item of listed.items ?? []) if (typeof item?.name === "string" && typeof item.status === "string") apps[item.name] = item.status;
  return apps;
}
