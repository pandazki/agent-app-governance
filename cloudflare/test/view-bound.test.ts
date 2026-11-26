import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppModel, BackModel, HomeModel, PageModel } from "../../local/src/page-model";
import { folderKey, HISTORY_KEPT, INDEX_KEY, PLANS_KEPT, plansKey, summaryKey, VIEW_SCHEMA, viewKey, type StoredIndex, type StoredPlans, type StoredView } from "../src/protocol";
import { PAGE_COOKIE } from "../worker/page";
import { growFolder } from "./grow";
import { modelOf, startStack, type Stack } from "./stack";

// An app that lived long: its stored view stays the same size, a plan for going back to an older version is worked
// out when the owner opens it and kept only for the folder it was worked out from, and the whole history is read from
// the folder when someone asks for it. The whole edition on one machine (test/stack.ts), with an app grown to 70
// versions of realistic size (test/grow.ts).

const CLI = join(import.meta.dir, "..", "bin", "appgov.mjs");
const VERSIONS = 70;
let buildBefore = false;
let stack: Stack;
let root: string;
let ownerHome: string;
let session: { cookie: string; csrf: string };
let waiting = "";

const env = (owner: boolean) => ({ PATH: process.env.PATH ?? "", HOME: root, APPGOV_HOME: owner ? ownerHome : join(root, "agent-home"), APPGOV_AGENT: "codex" });
function cli(cwd: string, args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI, ...args], { cwd, env: env(false), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("close", (code) => resolve({ code, out }));
  });
}
async function owner(cwd: string, args: string[], answers: string[] = []): Promise<number | null> {
  let out = "";
  let answered = 0;
  return Bun.spawn(["node", CLI, ...args], {
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
  }).exited;
}

const apps = () => join(root, "apps");
const copy = (app = "long") => join(apps(), app);
const json = <T>(key: string): T => JSON.parse(new TextDecoder().decode(stack.bucket.objects.get(key)!.bytes)) as T;
const ops = () => stack.operations.length;
const opsSince = (from: number) => stack.operations.slice(from);
async function page<T extends PageModel>(path: string): Promise<{ status: number; model: T; timing: string }> {
  const res = await fetch(`${stack.url}${path}`, { headers: { cookie: `${PAGE_COOKIE}=${session.cookie}` } });
  return { status: res.status, model: modelOf(await res.text()) as T, timing: res.headers.get("server-timing") ?? "" };
}
async function write(path: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`${stack.url}${path}`, { method: "POST", headers: { origin: stack.url, "content-type": "application/json", cookie: `${PAGE_COOKIE}=${session.cookie}`, "x-appgov-csrf": session.csrf }, body: JSON.stringify(body) });
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}
async function wholeHistory(): Promise<Record<string, unknown>[]> {
  return ((await (await stack.containerRead("long", "/apps/long/history")).json()) as { history: Record<string, unknown>[] }).history;
}
const intent = (k: number) => `“Change number ${k}: a small change to the page's style”`;

beforeAll(async () => {
  stack = await startStack({ buildBefore: () => buildBefore });
  root = mkdtempSync(join(tmpdir(), "appgov-cf-bound-"));
  ownerHome = join(root, "owner-home");
  mkdirSync(join(ownerHome, "hosts", "test"), { recursive: true });
  mkdirSync(join(root, "agent-home"), { recursive: true });
  mkdirSync(apps(), { recursive: true });
  writeFileSync(join(ownerHome, "hosts", "test", "owner.json"), JSON.stringify({ url: stack.url, key: stack.ownerKey }), { mode: 0o600 });
  expect(await owner(root, ["--host", stack.url, "login"])).toBe(0);
  expect(await owner(root, ["--host", stack.url, "token", "create", "--label", "laptop", "--write", apps()], ["create"])).toBe(0);
  expect((await cli(apps(), ["create", "long"])).code).toBe(0);
  writeFileSync(join(copy(), "app", "public", "style.css"), "body { background: #fafaf7; }\n");
  expect((await cli(copy(), ["submit", "A warmer page"])).code).toBe(0);
  await growFolder(stack, "long", VERSIONS);
  expect((await cli(copy(), ["fetch"])).code).toBe(0);
  writeFileSync(join(copy(), "app", "server.mjs"), `${readFileSync(join(copy(), "app", "server.mjs"), "utf8")}\n// Notes start over\n`);
  const sent = await cli(copy(), ["submit", "Start the notes over", "--one-way", "Every note saved so far"]);
  expect(sent.code).toBe(2);
  waiting = /needs_approval (\S+):/.exec(sent.out)![1]!;
  const res = await fetch(`${stack.url}/owner/signin`, { method: "POST", headers: { origin: stack.url, "content-type": "application/json" }, body: JSON.stringify({ key: stack.ownerKey }) });
  const cookie = /__Host-appgov-page=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1]!;
  session = { cookie, csrf: "" };
  session = { cookie, csrf: String(((await page<AppModel>("/")).model.access as { csrf?: string }).csrf ?? "") };
}, 300_000);

afterAll(async () => {
  await stack?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("the stored view of an app that lived long", () => {
  test(`it holds the newest ${HISTORY_KEPT} history entries and plans for the ${PLANS_KEPT} versions nearest the current one`, async () => {
    const view = json<StoredView>(viewKey("long"));
    const whole = await wholeHistory();
    expect(view.schema).toBe(VIEW_SCHEMA);
    expect(view.folder_etag).toBe(stack.bucket.objects.get(folderKey("long"))!.etag);
    expect(whole.length).toBeGreaterThan(HISTORY_KEPT);
    expect(view.history_total).toBe(whole.length);
    expect(view.history).toEqual(whole.slice(-HISTORY_KEPT));
    expect(Object.keys(view.plans)).toEqual(Array.from({ length: PLANS_KEPT }, (_, i) => `v${VERSIONS - 1 - i}`));
    // The entries those plans read are all in the view's history: none is stored twice.
    for (const plan of Object.values(view.plans)) expect(plan?.entries).toEqual([]);
    expect(stack.bucket.objects.get(viewKey("long"))!.bytes.length).toBeLessThan(80_000);
  });

  test("the app's page shows the newest part from the view without a container, and opens the whole history from the folder", async () => {
    let from = ops();
    const app = await page<AppModel>("/app/long?lang=en");
    expect(app.status).toBe(200);
    expect(opsSince(from)).toEqual([]);
    expect(app.model.history.length).toBeLessThanOrEqual(HISTORY_KEPT + 1);
    expect(app.model.history.some((row) => row.title === intent(VERSIONS))).toBe(true);
    expect(app.model.earlier).toEqual({ label: "Show the whole history", href: "/app/long/history?lang=en" });
    expect(app.model.historyAll).toBeUndefined();

    from = ops();
    const all = await page<AppModel>("/app/long/history?lang=en");
    expect(all.status).toBe(200);
    expect(opsSince(from)).toEqual(["read"]);
    expect(all.model.historyAll).toBe(true);
    expect(all.model.earlier).toBeUndefined();
    expect(all.model.history.length).toBeGreaterThan(VERSIONS - 1);
    expect(all.model.history.at(-1)!.title).toBe("Created the app");
    // The rows the app's page shows are the whole history's newest ones, word for word.
    expect(JSON.stringify(app.model.history.slice(0, 20))).toBe(JSON.stringify(all.model.history.slice(0, 20)));
  });

  test("going back to a near version reads its plan from the view; to an older one, the container works it out once and it is kept for this folder", async () => {
    let from = ops();
    const near = await page<BackModel>(`/app/long/back/v${VERSIONS - 3}?lang=en`);
    expect([near.model.kind, near.model.undone.length]).toEqual(["plan", 3]);
    expect(opsSince(from).filter((op) => op !== "warm")).toEqual([]);
    expect(near.timing).toContain('plan-source;desc="view"');

    from = ops();
    const old = await page<BackModel>("/app/long/back/v10?lang=en");
    expect(old.model.kind).toBe("plan");
    expect(old.model.heading).toContain(intent(10));
    expect(old.model.undone.length).toBe(VERSIONS - 10);
    expect(old.model.undone[0]!.title).toBe(intent(VERSIONS));
    expect(old.model.undone.at(-1)!.title).toBe(intent(11));
    expect(opsSince(from).filter((op) => op !== "warm")).toEqual(["plan"]);
    expect(old.timing).toContain('plan-source;desc="container"');
    const kept = json<StoredPlans>(plansKey("long"));
    expect(kept.folder_etag).toBe(stack.bucket.objects.get(folderKey("long"))!.etag);
    expect(kept.plans.map((entry) => entry.version)).toEqual(["v10"]);

    from = ops();
    const again = await page<BackModel>("/app/long/back/v10?lang=en");
    expect(opsSince(from).filter((op) => op !== "warm")).toEqual([]);
    expect(again.timing).toContain('plan-source;desc="stored"');
    expect(JSON.stringify({ ...again.model, now: 0 })).toBe(JSON.stringify({ ...old.model, now: 0 }));
  });

  test(`at most ${PLANS_KEPT} plans asked for are kept, the last ones`, async () => {
    for (let k = 11; k <= 20; k++) expect((await page<BackModel>(`/app/long/back/v${k}?lang=en`)).model.kind).toBe("plan");
    expect(json<StoredPlans>(plansKey("long")).plans.map((entry) => entry.version)).toEqual(Array.from({ length: PLANS_KEPT }, (_, i) => `v${20 - PLANS_KEPT + 1 + i}`));
  });

  test("a plan kept for another folder is never shown: after a write, or named for another etag, it is worked out again", async () => {
    // Named for a folder that is not the one in R2, with a plan that is not true: not taken.
    const forged: StoredPlans = { schema: VIEW_SCHEMA, app: "long", folder_etag: "not-this-folder", plans: [{ version: "v12", plan: { from: `v${VERSIONS}`, target: "v12", undone: ["v99"], oneWay: [], crossing: null, entries: [] } }] };
    stack.bucket.write(plansKey("long"), new TextEncoder().encode(JSON.stringify(forged)));
    let from = ops();
    const plan = await page<BackModel>("/app/long/back/v12?lang=en");
    expect(opsSince(from).filter((op) => op !== "warm")).toEqual(["plan"]);
    expect(plan.model.undone.length).toBe(VERSIONS - 12);
    expect(json<StoredPlans>(plansKey("long")).plans.map((entry) => entry.version)).toEqual(["v12"]);

    // A write saves the folder under a new etag: what was kept describes the folder before it.
    const said = await write(`/owner/apps/long/changes/${waiting}/deny`, { reason: "not now" });
    expect(said.status).toBe(200);
    const etag = stack.bucket.objects.get(folderKey("long"))!.etag;
    expect(json<StoredPlans>(plansKey("long")).folder_etag).not.toBe(etag);
    from = ops();
    const after = await page<BackModel>("/app/long/back/v12?lang=en");
    expect(opsSince(from).filter((op) => op !== "warm")).toEqual(["plan"]);
    expect(after.model.kind).toBe("plan");
    const kept = json<StoredPlans>(plansKey("long"));
    expect([kept.folder_etag, kept.plans.map((entry) => entry.version)]).toEqual([etag, ["v12"]]);
  });

  test("a Durable Object on the build before is asked the plan it knows, with the whole history beside it, and nothing is kept", async () => {
    const before = stack.bucket.objects.get(plansKey("long"))!.etag;
    buildBefore = true;
    try {
      const from = ops();
      const plan = await page<BackModel>("/app/long/back/v30?lang=en");
      expect(plan.model.kind).toBe("plan");
      expect(plan.model.heading).toContain(intent(30));
      expect(plan.model.undone.length).toBe(VERSIONS - 30);
      expect(opsSince(from).filter((op) => op !== "warm")).toEqual(["plan", "read", "read"]);
      expect(plan.timing).toContain('plan-source;desc="legacy"');
      expect(stack.bucket.objects.get(plansKey("long"))!.etag).toBe(before);
    } finally {
      buildBefore = false;
    }
  });

  test("the CLI's history of an app that lived long is whole, read from its folder; its status still comes from the view", async () => {
    let from = ops();
    const history = await cli(copy(), ["history"]);
    expect(history.code).toBe(0);
    expect(opsSince(from)).toEqual(["read"]);
    expect(history.out).toContain("Create the app from the PneumaSpace template");
    expect(history.out).toContain("Change number 3:");
    from = ops();
    expect((await cli(copy(), ["status"])).code).toBe(0);
    expect(opsSince(from)).toEqual([]);
  });
});

describe("the index of the apps' summaries", () => {
  test("two apps saved at the same moment both end in the index, each with the etag of its summary, and the list shows both", async () => {
    for (const app of ["one", "two"]) expect((await cli(apps(), ["create", app])).code).toBe(0);
    for (const app of ["one", "two"]) writeFileSync(join(copy(app), "app", "public", "style.css"), `body { color: ${app === "one" ? "#111" : "#222"}; }\n`);
    // Each app's Durable Object runs its own operations; the two run side by side.
    const sent = await Promise.all(["one", "two"].map((app) => cli(copy(app), ["submit", `A change to ${app}`])));
    expect(sent.map((r) => r.code)).toEqual([0, 0]);
    const index = json<StoredIndex>(INDEX_KEY);
    for (const app of ["long", "one", "two"]) expect(index.apps[app]?.etag).toBe(stack.bucket.objects.get(summaryKey(app))!.etag);
    const home = await page<HomeModel>("/?lang=en");
    expect(home.timing).not.toContain("r2-summaries");
    expect(JSON.stringify(home.model)).toContain("A change to one");
    expect(JSON.stringify(home.model)).toContain("A change to two");
  });
});
