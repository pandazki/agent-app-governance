import { INDEX_KEY, VIEW_SCHEMA, type StoredIndex } from "../src/protocol";
import type { FolderBucket } from "./folders";

// ---------------------------------------------------------------------------
// The list of apps in one round trip to R2 instead of two: every app's summary
// is also kept in one index object (StoredIndex in src/protocol.ts), with the
// etag of the summary object it copies.
//
// The summaries under `summaries/<app>.json` stay the record. A reader lists
// them (which gives each one's etag) and reads the index at the same moment; it
// takes an app's summary from the index only where the index holds the very
// object listed (same etag), and reads the summary itself otherwise. So the list
// is right whatever state the index is in: missing, behind (a write by a
// Durable Object still on a build before the index, a put that did not get
// through), holding an app that was removed by hand, or of another shape. A
// reader that found it wrong puts it right afterwards, as below.
//
// Each app's Durable Object, after it put the app's summary, puts the summary
// and its etag in the index over the etag it read (only where none is, when
// there is none, building it from the listing), and reads it again when another
// writer got there first: two apps saved at the same moment each end with their
// entry in it, so the index stays whole and readers seldom read a summary
// itself. The tests run this against a bucket that delays every read and write
// at random, with many apps saved at once.
// ---------------------------------------------------------------------------

const TRIES = 12;

export type IndexEntry = StoredIndex["apps"][string];

/** The index as R2 has it: its etag and, when it is of this Worker's shape, its entries. */
export async function readIndex(bucket: FolderBucket): Promise<{ etag: string; index: StoredIndex | null } | null> {
  const found = await bucket.get(INDEX_KEY);
  if (!found) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(await found.bytes())) as Partial<StoredIndex>;
    if (value.schema === VIEW_SCHEMA && typeof value.apps === "object" && value.apps !== null && !Array.isArray(value.apps)) return { etag: found.etag, index: value as StoredIndex };
  } catch {}
  return { etag: found.etag, index: null };
}

const appOf = (key: string) => key.slice("summaries/".length, -".json".length);

async function readSummary(bucket: FolderBucket, key: string): Promise<IndexEntry | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  try {
    return { etag: object.etag, summary: JSON.parse(new TextDecoder().decode(await object.bytes())) as Record<string, unknown> };
  } catch {
    return null;
  }
}

/**
 * Every summary under `summaries/`, by app: from the index where it holds the object listed, read otherwise. `stale`
 * says whether the index differed from the listing (missing, behind, or holding an app no longer listed).
 */
async function current(bucket: FolderBucket, steps: Record<string, number>): Promise<{ apps: Record<string, IndexEntry>; found: { etag: string; index: StoredIndex | null } | null; stale: boolean }> {
  const at = Date.now();
  const timed = async <T>(name: string, work: Promise<T>) => {
    try {
      return await work;
    } finally {
      steps[name] = Date.now() - at;
    }
  };
  const [listed, found] = await Promise.all([timed("r2-list", bucket.list("summaries/")), timed("r2-index", readIndex(bucket).catch(() => null))]);
  const kept = found?.index?.apps ?? {};
  const apps: Record<string, IndexEntry> = {};
  const missed: { app: string; key: string }[] = [];
  for (const { key, etag } of listed) {
    const app = appOf(key);
    if (kept[app]?.etag === etag) apps[app] = kept[app]!;
    else missed.push({ app, key });
  }
  if (missed.length) {
    const began = Date.now();
    // Read side by side: the list waits for the slowest summary, not for all of them in a row.
    for (const [i, entry] of (await Promise.all(missed.map((m) => readSummary(bucket, m.key)))).entries()) if (entry) apps[missed[i]!.app] = entry;
    steps["r2-summaries"] = Date.now() - began;
  }
  const stale = !found?.index || missed.length > 0 || Object.keys(kept).some((app) => !(app in apps));
  return { apps, found, stale };
}

/** The index made to hold `apps`, over the etag it was read with (only where none is, when there was none): false when another writer got there first. */
async function putIndex(bucket: FolderBucket, apps: Record<string, IndexEntry>, over: string | null): Promise<boolean> {
  const next: StoredIndex = { schema: VIEW_SCHEMA, apps };
  return (await bucket.put(INDEX_KEY, JSON.stringify(next), over ? { etagMatches: over } : { etagDoesNotMatch: "*" })) !== null;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** After the app's summary was put (with `etag`): its entry in the index, without losing another app's put at the same moment. */
export async function putInIndex(bucket: FolderBucket, app: string, entry: IndexEntry): Promise<boolean> {
  for (let attempt = 0; attempt < TRIES; attempt++) {
    if (attempt) await pause(5 + Math.random() * 20 * attempt);
    try {
      const found = await readIndex(bucket);
      // None yet, or of another shape: built whole from the listing (this app's summary is already among them).
      const apps = found?.index ? { ...found.index.apps } : (await current(bucket, {})).apps;
      apps[app] = entry;
      if (await putIndex(bucket, apps, found?.etag ?? null)) return true;
    } catch {}
  }
  return false;
}

/**
 * The summaries the list of apps shows, as R2 has them now. `steps` gets how long each part took: `r2-list` and
 * `r2-index` (side by side), and `r2-summaries` when some summary had to be read itself. When the index differed, it is
 * put right meanwhile, over the etag it was read with.
 */
export async function appSummaries(bucket: FolderBucket, meanwhile: (work: Promise<unknown>) => void, steps: Record<string, number> = {}): Promise<unknown[]> {
  const { apps, found, stale } = await current(bucket, steps);
  if (stale) meanwhile(putIndex(bucket, apps, found?.etag ?? null).catch(() => false));
  return Object.values(apps).map((entry) => entry.summary);
}
