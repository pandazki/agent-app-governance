import { describe, expect, test } from "bun:test";
import { INDEX_KEY, summaryKey, VIEW_SCHEMA, type StoredIndex } from "../src/protocol";
import { appSummaries, putInIndex } from "../worker/apps-index";
import type { FolderBucket } from "../worker/folders";
import { MemoryBucket } from "./stack";

// The index of the apps' summaries (worker/apps-index.ts) under writers and readers at the same moment. R2's own
// operations are atomic, as the memory bucket's are; between them anything may happen, so this bucket waits a random
// moment before and after each one, and many apps are saved at once.

/** The memory bucket, with every operation taking a random 0 to 4 ms on each side. */
function slow(bucket: MemoryBucket): FolderBucket {
  const wait = () => new Promise((resolve) => setTimeout(resolve, Math.random() * 4));
  const around = async <T>(work: () => Promise<T>): Promise<T> => {
    await wait();
    const out = await work();
    await wait();
    return out;
  };
  return {
    get: (key) => around(() => bucket.get(key)),
    put: (key, value, condition) => around(() => bucket.put(key, value, condition)),
    list: (prefix) => around(() => bucket.list(prefix)),
    delete: (keys) => around(() => bucket.delete(keys)),
  };
}

/** One write of one app, as its Durable Object does it: the summary, then its entry in the index. */
async function save(bucket: FolderBucket, app: string, n: number): Promise<boolean> {
  const summary = { app_id: app, last_change: { intent: `change ${n}` } };
  const put = await bucket.put(summaryKey(app), JSON.stringify(summary));
  return putInIndex(bucket, app, { etag: put!.etag, summary });
}

const index = (bucket: MemoryBucket) => JSON.parse(new TextDecoder().decode(bucket.objects.get(INDEX_KEY)!.bytes)) as StoredIndex;
/** Every app's summary as R2 has it now, with its etag: what the index must hold. */
const truth = (bucket: MemoryBucket) =>
  Object.fromEntries([...bucket.objects.entries()].filter(([key]) => key.startsWith("summaries/")).map(([key, value]) => [key.slice(10, -5), { etag: value.etag, summary: JSON.parse(new TextDecoder().decode(value.bytes)) }]));

describe("the index of the apps' summaries", () => {
  test("twenty apps saved at the same moment, three times each, from no index at all: every entry ends as its summary is", async () => {
    for (let round = 0; round < 5; round++) {
      const memory = new MemoryBucket();
      const bucket = slow(memory);
      const apps = Array.from({ length: 20 }, (_, i) => `app-${i}`);
      // One writer per app at a time (one Durable Object per app); the apps side by side.
      const results = await Promise.all(apps.map(async (app) => [await save(bucket, app, 1), await save(bucket, app, 2), await save(bucket, app, 3)]));
      expect(results.flat().every(Boolean)).toBe(true);
      expect(index(memory)).toEqual({ schema: VIEW_SCHEMA, apps: truth(memory) });
      expect(Object.values(index(memory).apps).every((entry) => (entry.summary.last_change as { intent: string }).intent === "change 3")).toBe(true);
    }
  });

  test("readers that build the index while apps are saved never lose a writer's entry, and always list what R2 has", async () => {
    for (let round = 0; round < 5; round++) {
      const memory = new MemoryBucket();
      const bucket = slow(memory);
      const apps = Array.from({ length: 12 }, (_, i) => `app-${i}`);
      for (const app of apps.slice(0, 6)) await bucket.put(summaryKey(app), JSON.stringify({ app_id: app, last_change: { intent: "before the index" } }));
      const building: Promise<unknown>[] = [];
      const reader = async () => {
        for (let i = 0; i < 6; i++) {
          const listed = (await appSummaries(bucket, (work) => void building.push(work))) as { app_id: string }[];
          // Whatever the index says, a reader lists one summary per app R2 has, at least the ones there before it began.
          expect(new Set(listed.map((s) => s.app_id)).size).toBe(listed.length);
        }
      };
      await Promise.all([...apps.map((app) => save(bucket, app, 1).then(() => save(bucket, app, 2))), reader(), reader()]);
      await Promise.all(building);
      expect(index(memory).apps).toEqual(truth(memory));
    }
  });

  test("an index that is wrong is never believed beyond the listing: behind, holding a removed app, or of another shape", async () => {
    const memory = new MemoryBucket();
    const steps: Record<string, number> = {};
    for (const app of ["a", "b"]) await save(memory, app, 1);
    // Behind: b saved again by a writer that did not put its entry (a build before the index); and c removed by hand.
    await memory.put(summaryKey("b"), JSON.stringify({ app_id: "b", last_change: { intent: "change 2" } }));
    const behind = index(memory);
    memory.write(INDEX_KEY, new TextEncoder().encode(JSON.stringify({ ...behind, apps: { ...behind.apps, c: { etag: "gone", summary: { app_id: "c" } } } })));
    const fixing: Promise<unknown>[] = [];
    const listed = (await appSummaries(memory, (work) => void fixing.push(work), steps)) as { app_id: string; last_change: { intent: string } }[];
    expect(listed.map((s) => [s.app_id, s.last_change.intent]).sort()).toEqual([["a", "change 1"], ["b", "change 2"]]);
    expect(Object.keys(steps).sort()).toEqual(["r2-index", "r2-list", "r2-summaries"]);
    await Promise.all(fixing);
    // Put right afterwards: the next reader reads no summary itself.
    expect(index(memory).apps).toEqual(truth(memory));
    const next: Record<string, number> = {};
    await appSummaries(memory, () => {}, next);
    expect(Object.keys(next).sort()).toEqual(["r2-index", "r2-list"]);

    memory.write(INDEX_KEY, new TextEncoder().encode(JSON.stringify({ schema: VIEW_SCHEMA + 1, everything: "else" })));
    expect(((await appSummaries(memory, () => {})) as { app_id: string }[]).map((s) => s.app_id).sort()).toEqual(["a", "b"]);
    memory.objects.delete(INDEX_KEY);
    expect(((await appSummaries(memory, () => {})) as { app_id: string }[]).map((s) => s.app_id).sort()).toEqual(["a", "b"]);
  });
});
