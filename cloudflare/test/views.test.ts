import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppModel, BackModel, ChangeModel, HomeModel, PageModel, Rich } from "../../local/src/page-model";
import { folderKey, VIEW_SCHEMA, viewKey, type StoredView } from "../src/protocol";
import { csrfToken, PAGE_COOKIE } from "../worker/page";
import { asOf, usable } from "../worker/views";
import { modelOf, startStack, type Stack } from "./stack";

// The reads of one app, answered from its stored view without a container: the owner page's views, and the CLI's
// status and history. The whole edition on one machine (test/stack.ts); its log of the Durable Objects' operations
// and its count of container starts say whether a read reached a container.

const CLI = join(import.meta.dir, "..", "bin", "appgov.mjs");
const clock = { value: Date.now() };
let buildBefore = false;
let held: Promise<void> | null = null;
let release: () => void = () => {};
let stack: Stack;
let root: string;
let ownerHome: string;
let session: { cookie: string; csrf: string };
let waiting = "";

const env = (owner: boolean) => ({
  PATH: process.env.PATH ?? "",
  HOME: root,
  APPGOV_HOME: owner ? ownerHome : join(root, "agent-home"),
  APPGOV_AGENT: "codex",
});
function cli(cwd: string, args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI, ...args], {
      cwd,
      env: env(false),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("close", (code) => resolve({ code, out }));
  });
}
async function owner(cwd: string, args: string[], answers: string[] = []): Promise<number | null> {
  let out = "";
  let answered = 0;
  const child = Bun.spawn(["node", CLI, ...args], {
    cwd,
    env: env(true),
    terminal: {
      cols: 400,
      rows: 50,
      data(terminal, chunk) {
        out += new TextDecoder().decode(chunk);
        const asked = out.split('Type "').length - 1;
        while (answered < asked && answered < answers.length) terminal.write(`${answers[answered++]}\r`);
      },
    },
  });
  return child.exited;
}

const apps = () => join(root, "apps");
const copy = () => join(apps(), "notes");
const words = (rich: Rich) => rich.parts.map((part) => (typeof part === "string" ? part : "{when}")).join("");
const stored = (): StoredView => JSON.parse(new TextDecoder().decode(stack.bucket.objects.get(viewKey("notes"))!.bytes));
const folderEtag = () => stack.bucket.objects.get(folderKey("notes"))!.etag;
const ops = () => stack.operations.length;
const opsSince = (from: number) => stack.operations.slice(from);

async function page<T extends PageModel>(path: string, cookie: string | null = session.cookie, headers: Record<string, string> = {}): Promise<{ status: number; model: T }> {
  const res = await fetch(`${stack.url}${path}`, {
    headers: {
      ...headers,
      ...(cookie ? { cookie: `${PAGE_COOKIE}=${cookie}` } : {}),
    },
  });
  return { status: res.status, model: modelOf(await res.text()) as T };
}
async function write(path: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`${stack.url}${path}`, {
    method: "POST",
    headers: {
      origin: stack.url,
      "content-type": "application/json",
      cookie: `${PAGE_COOKIE}=${session.cookie}`,
      "x-appgov-csrf": session.csrf,
    },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    data: (await res.json()) as Record<string, unknown>,
  };
}
async function until(check: () => boolean, ms = 30_000) {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(20)) if (check()) return;
  throw new Error("timed out");
}
/** The page model without what differs between two requests of the same view: the server's clock and the session's token. */
const comparable = (model: PageModel) => JSON.stringify({ ...model, now: 0, access: null });

beforeAll(async () => {
  stack = await startStack({
    now: () => clock.value,
    buildBefore: () => buildBefore,
    beforeOperation: async (_method, _path, op) => {
      if (op === "warm" && held) await held;
    },
  });
  root = mkdtempSync(join(tmpdir(), "appgov-cf-views-"));
  ownerHome = join(root, "owner-home");
  mkdirSync(join(ownerHome, "hosts", "test"), { recursive: true });
  mkdirSync(join(root, "agent-home"), { recursive: true });
  mkdirSync(apps(), { recursive: true });
  writeFileSync(join(ownerHome, "hosts", "test", "owner.json"), JSON.stringify({ url: stack.url, key: stack.ownerKey }), { mode: 0o600 });
  expect(await owner(root, ["--host", stack.url, "login"])).toBe(0);
  expect(await owner(root, ["--host", stack.url, "token", "create", "--label", "laptop", "--write", apps()], ["create"])).toBe(0);
  expect((await cli(apps(), ["create", "notes"])).code).toBe(0);
  writeFileSync(join(copy(), "app", "public", "style.css"), "body { background: #fafaf7; }\n");
  expect((await cli(copy(), ["submit", "A warmer page"])).code).toBe(0);
  const manifest = JSON.parse(readFileSync(join(copy(), "pneuma-space.json"), "utf8"));
  manifest.capabilities.identity = {};
  writeFileSync(join(copy(), "pneuma-space.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const sent = await cli(copy(), ["submit", "Let anyone in"]);
  expect(sent.code).toBe(2);
  waiting = /needs_approval (\S+):/.exec(sent.out)![1]!;
  const res = await fetch(`${stack.url}/owner/signin`, {
    method: "POST",
    headers: { origin: stack.url, "content-type": "application/json" },
    body: JSON.stringify({ key: stack.ownerKey }),
  });
  const cookie = /__Host-appgov-page=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")![1]!;
  session = { cookie, csrf: await csrfToken(cookie) };
});

afterAll(async () => {
  release();
  await stack.close();
  rmSync(root, { recursive: true, force: true });
});

describe("reads from the stored view", () => {
  test("every operation that saved the folder stored its view, naming the folder's etag", () => {
    const view = stored();
    expect(view.schema).toBe(VIEW_SCHEMA);
    expect(view.folder_etag).toBe(folderEtag());
    expect(view.status.active_version).toBe("v2");
    expect((view.status.pending as { change_id: string }[]).map((p) => p.change_id)).toEqual([waiting]);
    expect(Object.keys(view.plans)).toEqual(["v1"]);
  });

  test("every view a person opens answers with the container gone, and starts none to answer", async () => {
    await stack.dropContainer();
    const [starts, from] = [stack.starts(), ops()];
    held = new Promise((resolve) => (release = resolve));
    try {
      const home = await page<HomeModel>("/");
      const app = await page<AppModel>("/app/notes");
      const change = await page<ChangeModel>(`/app/notes/change/${waiting}`);
      const back = await page<BackModel>("/app/notes/back/v1");
      expect([home.status, app.status, change.status, back.status]).toEqual([200, 200, 200, 200]);
      expect(home.model.waiting).toHaveLength(1);
      expect(app.model.history.map((row) => row.title)).toEqual(["“Let anyone in”", "“A warmer page”", "Created the app"]);
      expect(change.model.why).toContain("Anyone with the address could open the app without signing in.");
      expect(change.model.after.open).toMatch(/^https:\/\/plane\.test\/apps\/notes-pv[a-z0-9]+\/$/);
      expect([back.model.kind, back.model.from]).toEqual(["plan", "v2"]);
      // The views answered while the only container work, starting it ahead of a decision, still waited (the second
      // waits behind the first in the app's queue).
      expect(stack.starts()).toBe(starts);
      expect(opsSince(from)).toEqual(["warm"]);
    } finally {
      release();
      held = null;
    }
    await until(() => opsSince(from).length === 2);
    await until(() => stack.starts() === starts + 1);
  });

  test("the CLI's status and history read the stored view too; its comparison with the working copy still holds", async () => {
    await stack.dropContainer();
    const [starts, from] = [stack.starts(), ops()];
    const status = await cli(copy(), ["status"]);
    expect(status.code).toBe(0);
    expect(status.out).toContain(`waiting for the owner: ${waiting} "Let anyone in"`);
    // The edits here are the change that waits: the files signature in the stored view says so.
    expect(status.out).toContain(`These edits are change ${waiting}, which was submitted and waits for the owner.`);
    const history = await cli(copy(), ["history"]);
    expect(history.code).toBe(0);
    expect(history.out).toMatch(/change needs_approval by codex \(agent token "laptop" \(t[0-9a-f]+\)\) \[agent-driven\]: Let anyone in/);
    expect([stack.starts(), opsSince(from)]).toEqual([starts, []]);
  });

  test("the stored view is what the container computes for the same folder, and the page says the same from either", async () => {
    const view = stored();
    const answer = async (path: string) => {
      const { timing: _timing, ...rest } = (await (await stack.containerRead("notes", path)).json()) as Record<string, unknown>;
      return rest;
    };
    expect(view.status).toEqual(await answer("/apps/notes"));
    expect({ history: view.history } as Record<string, unknown>).toEqual(await answer("/apps/notes/history"));
    expect(view.plans.v1).toEqual(await answer("/apps/notes/undo-plan/v1"));
    // The same views, from the stored view and from one the container computes when none is stored.
    const paths = ["/app/notes", `/app/notes/change/${waiting}`, "/app/notes/back/v1"];
    const fromStored = await Promise.all(paths.map(async (p) => comparable((await page(p)).model)));
    for (const [i, path] of paths.entries()) {
      stack.bucket.objects.delete(viewKey("notes"));
      expect(comparable((await page(path)).model)).toBe(fromStored[i]!);
    }
  });

  test("a view of another folder than the one in R2 is not served: the container computes it once, and it is stored again", async () => {
    // Another writer saved the folder (here: the same bytes under a new etag), and the view was not stored after it.
    stack.bucket.write(folderKey("notes"), stack.bucket.objects.get(folderKey("notes"))!.bytes);
    expect(stored().folder_etag).not.toBe(folderEtag());
    let from = ops();
    expect((await page<AppModel>("/app/notes")).status).toBe(200);
    expect(opsSince(from)).toEqual(["view"]);
    expect(stored().folder_etag).toBe(folderEtag());
    from = ops();
    await page<AppModel>("/app/notes");
    expect((await cli(copy(), ["status"])).code).toBe(0);
    expect(opsSince(from)).toEqual([]);
  });

  test("a view of another shape (a build that changed it) or none at all (a build before stored views) is replaced once", async () => {
    stack.bucket.write(viewKey("notes"), new TextEncoder().encode(JSON.stringify({ ...stored(), schema: VIEW_SCHEMA - 1 })));
    // The folder's etag is unchanged: the shape alone sends the reader to the container.
    let from = ops();
    expect((await cli(copy(), ["history"])).code).toBe(0);
    expect(opsSince(from)).toEqual(["view"]);
    expect(stored().schema).toBe(VIEW_SCHEMA);
    stack.bucket.objects.delete(viewKey("notes"));
    from = ops();
    expect((await page<AppModel>("/app/notes")).status).toBe(200);
    expect((await page<AppModel>("/app/notes")).status).toBe(200);
    expect(opsSince(from)).toEqual(["view"]);
  });

  test("right after a deploy, a Durable Object still on the build before is asked the reads it knows, and a view is stored once it restarts", async () => {
    stack.bucket.objects.delete(viewKey("notes"));
    buildBefore = true;
    try {
      let from = ops();
      const app = await page<AppModel>("/app/notes");
      expect(app.status).toBe(200);
      expect(app.model.history.map((row) => row.title)).toEqual(["“Let anyone in”", "“A warmer page”", "Created the app"]);
      expect(opsSince(from)).toEqual(["view", "read", "read"]);
      from = ops();
      const back = await page<BackModel>("/app/notes/back/v1");
      expect([back.status, back.model.kind]).toEqual([200, "plan"]);
      // (The container it then starts ahead of going back is refused the same way, in the background.)
      expect(opsSince(from).filter((op) => op !== "warm")).toEqual(["view", "read", "read", "read"]);
      const status = await cli(copy(), ["status", "--json"]);
      expect([status.code, JSON.parse(status.out).timing.view]).toEqual([0, "legacy"]);
      const read = await fetch(`${stack.url}/app/notes`, { headers: { cookie: `${PAGE_COOKIE}=${session.cookie}` } });
      expect(read.headers.get("server-timing")).toMatch(/container;dur=\d+, legacy;dur=\d+, source;desc="legacy"$/);
      expect(stack.bucket.objects.has(viewKey("notes"))).toBe(false);
    } finally {
      buildBefore = false;
    }
    const from = ops();
    expect((await page<AppModel>("/app/notes")).status).toBe(200);
    expect(opsSince(from)).toEqual(["view"]);
    expect(stored().folder_etag).toBe(folderEtag());
  });

  test("what time changes is worked out from the stored instants: the preview's end, and when things happened", async () => {
    const preview = (
      stored().status.pending as {
        preview: { state: string; expires_at: string };
      }[]
    )[0]!.preview;
    expect(preview.state).toBe("standing");
    const ends = Date.parse(preview.expires_at);
    clock.value = ends - 8 * 60_000;
    const before = (await page<ChangeModel>(`/app/notes/change/${waiting}`)).model;
    expect(before.now).toBe(clock.value);
    expect(words(before.after.note!)).toBe("ends itself {when}");
    expect(before.after.note!.parts.find((part) => typeof part !== "string")).toEqual({ at: preview.expires_at, mode: "rel", label: "in 8 minutes" });
    expect(before.decision.blocked).toBeNull();
    // Past its end the preview is gone, as PneumaSpace would say: the page says so, and offers to show it again.
    clock.value = ends + 1000;
    const after = (await page<ChangeModel>(`/app/notes/change/${waiting}`)).model;
    expect(after.after.open).toBeNull();
    expect(after.after.empty?.text).toBe("The preview isn't running any more.");
    expect(after.after.again).not.toBeNull();
    expect(after.decision.blocked).not.toBeNull();
    const status = await cli(copy(), ["status"]);
    expect(status.out).toContain("ended itself");
    // "2 minutes ago", from when the change was recorded and the Worker's clock now.
    const recorded = Date.parse(String(stored().history.at(-1)!.at));
    clock.value = recorded + 2 * 60_000 + 5000;
    const app = (await page<AppModel>("/app/notes")).model;
    expect(app.history[0]!.when.parts[0]).toEqual({ at: String(stored().history.at(-1)!.at), mode: "rel", label: "2 minutes ago" });
    clock.value = Date.now();
  });

  test("a read says in Server-Timing where its time went in the Worker; the sign-in view says nothing", async () => {
    const steps = (header: string | null) => (header ?? "").split(", ").map((entry) => entry.split(";")[0]);
    const viewed = await fetch(`${stack.url}/app/notes`, { headers: { cookie: `${PAGE_COOKIE}=${session.cookie}` } });
    expect(steps(viewed.headers.get("server-timing"))).toEqual(["summaries", "r2-view", "r2-head", "source"]);
    expect(viewed.headers.get("server-timing")).toMatch(/r2-view;dur=\d+, r2-head;dur=\d+, source;desc="stored"$/);
    const token = String(JSON.parse(readFileSync(join(apps(), ".appgov", "centre.json"), "utf8")).token);
    const read = await fetch(`${stack.url}/apps/notes/history`, { headers: { authorization: `Bearer ${token}` } });
    expect(steps(read.headers.get("server-timing"))).toEqual(["r2-view", "r2-head", "source"]);
    expect((await fetch(`${stack.url}/app/notes`)).headers.get("server-timing")).toBeNull();
  });

  test("the sign-in rules hold on the new read path: nothing without a session, and an agent token or CLI session is no session", async () => {
    const from = ops();
    const starts = stack.starts();
    const token = String(JSON.parse(readFileSync(join(apps(), ".appgov", "centre.json"), "utf8")).token);
    const cliSession = String(JSON.parse(readFileSync(join(ownerHome, "hosts", "test", "session.json"), "utf8")).session);
    for (const [cookie, headers] of [
      [null, {}],
      [null, { authorization: `Bearer ${token}` }],
      [null, { authorization: `Bearer ${cliSession}` }],
      [token, {}],
      [cliSession, {}],
    ] as const) {
      for (const path of ["/app/notes", `/app/notes/change/${waiting}`, "/app/notes/back/v1"]) {
        const seen = await page(path, cookie, headers);
        expect([path, seen.status, seen.model.view]).toEqual([path, 401, "signin"]);
      }
    }
    // The API's reads take its own credentials only.
    expect((await fetch(`${stack.url}/apps/notes`)).status).toBe(401);
    expect(
      (
        await fetch(`${stack.url}/apps/notes/history`, {
          headers: { cookie: `${PAGE_COOKIE}=${session.cookie}` },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${stack.url}/apps/notes`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(200);
    // Nothing was read for them, and no container was woken.
    await Bun.sleep(100);
    expect([opsSince(from), stack.starts()]).toEqual([[], starts]);
  });

  test("a decision still goes through the container, once, after the container the change view woke; the view follows it", async () => {
    await stack.dropContainer();
    expect((await page<ChangeModel>(`/app/notes/change/${waiting}`)).status).toBe(200);
    await until(() => stack.operations.at(-1) === "warm");
    await Bun.sleep(50);
    const starts = stack.starts();
    const from = ops();
    const decided = await write(`/owner/apps/notes/changes/${waiting}/approve`);
    expect(decided.status).toBe(200);
    expect(opsSince(from)).toEqual(["write"]);
    // The container the change view started took the decision: none started for it.
    expect(stack.starts()).toBe(starts);
    expect(stored().folder_etag).toBe(folderEtag());
    expect(stored().status.active_version).toBe("v3");
    await stack.dropContainer();
    const after = ops();
    const app = (await page<AppModel>("/app/notes?done=live")).model;
    expect(app.done).toBe("It's live now.");
    expect(app.history[0]!.pill).toEqual({
      label: "Running now",
      tone: "green",
    });
    expect(Object.keys(stored().plans)).toEqual(["v2", "v1"]);
    expect(opsSince(after)).toEqual([]);
  });
});

describe("the stored view's rules, on their own", () => {
  const view = {
    schema: VIEW_SCHEMA,
    app: "notes",
    folder_etag: "e1",
    computed_at: "",
    status: {},
    history: [],
    plans: {},
  };

  test("a view is served only for its app, its folder's etag and this Worker's shape", () => {
    expect(usable(view, "notes", "e1")).toBe(true);
    expect(usable(view, "notes", null)).toBe(true);
    expect(usable(view, "other", "e1")).toBe(false);
    expect(usable(view, "notes", "e2")).toBe(false);
    expect(usable({ ...view, schema: VIEW_SCHEMA + 1 }, "notes", "e1")).toBe(false);
    expect(usable({ ...view, history: null }, "notes", "e1")).toBe(false);
    expect(usable(null, "notes", "e1")).toBe(false);
  });

  test("a preview past its end is gone; one before it, one without an end and one already gone are as they were", () => {
    const now = Date.parse("2026-11-26T10:00:00Z");
    const standing = (expires_at: string | null) => ({
      change_id: "c1",
      preview: {
        state: "standing",
        app: "notes-pvc1",
        address: "https://plane.test/apps/notes-pvc1/",
        expires_at,
      },
    });
    const status = {
      pending: [standing("2026-11-26T09:59:59Z"), standing("2026-11-26T10:00:01Z"), standing(null), { change_id: "c4", preview: { state: "gone", app: "x", note: "n" } }],
    };
    const seen = asOf(status, now).pending as {
      preview: Record<string, unknown>;
    }[];
    expect(seen[0]!.preview).toEqual({
      state: "gone",
      app: "notes-pvc1",
      note: "it ended itself at 2026-11-26T09:59:59Z",
    });
    expect(seen.slice(1)).toEqual(status.pending.slice(1) as never);
  });
});
