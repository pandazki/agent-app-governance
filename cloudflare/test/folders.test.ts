import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TREE } from "../../host/src/artifact";
import { packFolder, unpackFolder } from "../src/folder";
import { FOLDER_HEADER, folderKey, summaryKey } from "../src/protocol";
import { operate, type HostPort } from "../worker/folders";
import { MemoryBucket } from "./stack";

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "appgov-folders-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const toBuffer = (bytes: Uint8Array) => bytes.slice().buffer;

/** A container with one app folder on its disk, speaking the folder routes of src/server.ts. */
function fakeContainer(dir: string) {
  let loaded: string | null = null;
  const seen: string[] = [];
  const port: HostPort = {
    fetch: async (path, init) => {
      seen.push(path.split("?")[0]!);
      const url = new URL(`http://host${path}`);
      if (url.pathname === "/folder/load") {
        await unpackFolder(dir, new Uint8Array(init.body as ArrayBuffer));
        loaded = init.headers![FOLDER_HEADER]!;
        return Response.json({});
      }
      if (url.pathname === "/folder/save") return new Response(toBuffer((await packFolder(dir))!));
      if (url.pathname === "/folder/saved") return (loaded = url.searchParams.get("etag")), Response.json({});
      if (url.pathname === "/folder/forget") return (loaded = null), Response.json({});
      if (url.pathname === "/folder/summary") return Response.json({ app_id: "todo", note: readFileSync(join(dir, "note.txt"), "utf8") });
      // An operation: refused until the folder on disk is the one R2 holds, then it writes.
      if (init.headers![FOLDER_HEADER] !== "none" && init.headers![FOLDER_HEADER] !== loaded) return Response.json({ reason: "folder_not_loaded" }, { status: 412 });
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "note.txt"), String(init.body));
      return Response.json({ wrote: String(init.body) });
    },
  };
  return { port, seen, loaded: () => loaded };
}

describe("an app's folder in R2", () => {
  test("a tar round trip keeps every file, the record's included, and leaves installed dependencies out", async () => {
    const from = temp();
    for (const [path, body] of [
      ["app/server.mjs", "export {}\n"],
      [".pneuma-framework/record.json", '{"current_version":"v2"}\n'],
      [".pneuma-framework/versions/v1/app/server.mjs", "// v1\n"],
      [".appgov/app.json", '{"app_id":"todo"}\n'],
      [".appgov/pending/c1.json", "{}\n"],
      ["node_modules/x/index.js", "nope\n"],
    ] as const) {
      mkdirSync(join(from, path, ".."), { recursive: true });
      writeFileSync(join(from, path), body);
    }
    symlinkSync("app/server.mjs", join(from, "link.mjs"));
    const tar = await packFolder(from);
    const to = temp();
    writeFileSync(join(to, "stale.txt"), "from before\n");
    await unpackFolder(to, tar!);
    expect(readFileSync(join(to, ".pneuma-framework/versions/v1/app/server.mjs"), "utf8")).toBe("// v1\n");
    expect(readFileSync(join(to, ".appgov/pending/c1.json"), "utf8")).toBe("{}\n");
    expect(existsSync(join(to, "node_modules"))).toBe(false);
    expect(existsSync(join(to, "stale.txt"))).toBe(false);
    expect(await packFolder(join(to, "missing"))).toBeNull();
    // node_modules is never part of a version either.
    expect(TREE.ignoredDirs!.has("node_modules")).toBe(true);
  });

  test("an operation loads the folder into a container that lacks it, and saves the result over the etag it read", async () => {
    const bucket = new MemoryBucket();
    const container = fakeContainer(temp());
    const created = await operate(bucket, container.port, { app: "todo", op: "create", method: "POST", path: "/apps", headers: {}, body: "one" });
    expect(created.status).toBe(200);
    const first = bucket.objects.get(folderKey("todo"))!.etag;
    expect(bucket.objects.has(summaryKey("todo"))).toBe(true);

    // A new container: the same folder comes back from R2 before the operation runs.
    const fresh = fakeContainer(temp());
    const res = await operate(bucket, fresh.port, { app: "todo", op: "write", method: "POST", path: "/apps/todo/changes", headers: {}, body: "two" });
    expect(res.status).toBe(200);
    expect(fresh.seen.slice(0, 3)).toEqual(["/apps/todo/changes", "/folder/load", "/apps/todo/changes"]);
    expect(res.headers.get("x-appgov-timing")).toMatch(/load=\d+;op=\d+;save=\d+/);
    expect(bucket.objects.get(folderKey("todo"))!.etag).not.toBe(first);
    const restored = temp();
    await unpackFolder(restored, bucket.objects.get(folderKey("todo"))!.bytes);
    expect(readFileSync(join(restored, "note.txt"), "utf8")).toBe("two");
  });

  test("a conflicting write in R2 meanwhile wins: nothing is saved over it, and the container forgets its copy", async () => {
    const bucket = new MemoryBucket();
    const container = fakeContainer(temp());
    await operate(bucket, container.port, { app: "todo", op: "create", method: "POST", path: "/apps", headers: {}, body: "one" });
    const theirs = new TextEncoder().encode("someone else's tar");
    bucket.interloper = () => bucket.write(folderKey("todo"), theirs);
    const res = await operate(bucket, container.port, { app: "todo", op: "write", method: "POST", path: "/apps/todo/changes", headers: {}, body: "mine" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { reason: string; result: unknown }).reason).toBe("record_conflict");
    expect(bucket.objects.get(folderKey("todo"))!.bytes).toBe(theirs);
    expect(container.loaded()).toBeNull();
  });

  test("a create where the name is taken in R2, and an operation on an app R2 does not hold, reach no container", async () => {
    const bucket = new MemoryBucket();
    const container = fakeContainer(temp());
    expect((await operate(bucket, container.port, { app: "todo", op: "read", method: "GET", path: "/apps/todo", headers: {} })).status).toBe(404);
    bucket.write(folderKey("todo"), new Uint8Array());
    expect((await operate(bucket, container.port, { app: "todo", op: "create", method: "POST", path: "/apps", headers: {}, body: "x" })).status).toBe(409);
    expect(container.seen).toEqual([]);
  });

  test("a refusal before anything was written saves nothing", async () => {
    const bucket = new MemoryBucket();
    const container = fakeContainer(temp());
    await operate(bucket, container.port, { app: "todo", op: "create", method: "POST", path: "/apps", headers: {}, body: "one" });
    const etag = bucket.objects.get(folderKey("todo"))!.etag;
    const refusing: HostPort = { fetch: async (path, init) => (path.startsWith("/apps/") ? Response.json({ error: "no" }, { status: 403 }) : container.port.fetch(path, init)) };
    expect((await operate(bucket, refusing, { app: "todo", op: "write", method: "POST", path: "/apps/todo/changes", headers: {}, body: "x" })).status).toBe(403);
    expect(bucket.objects.get(folderKey("todo"))!.etag).toBe(etag);
  });
});
