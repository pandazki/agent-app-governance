import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppModel, HomeModel, PageModel } from "../../local/src/page-model";
import { folderKey, plansKey, summaryKey, viewKey } from "../src/protocol";
import { csrfToken, PAGE_COOKIE } from "../worker/page";
import { RUNTIME_KEY } from "../worker/runtime-check";
import { FAKE_TOKEN } from "./fake-plane";
import { modelOf, startStack, type Stack } from "./stack";

// Taking an app down, bringing it back, publishing it again and clearing it, on this edition's own answers (the whole
// edition on this machine, test/stack.ts, with the fake plane): the CLI in a terminal and the owner page, an agent
// token's refusals, what clearing leaves on a plane whose tokens may not purge, an app that vanishes behind the Host's
// back, and the stored views' honesty about it.

const CLI = join(import.meta.dir, "..", "bin", "appgov.mjs");
let stack: Stack;
let root: string;
let ownerHome: string;
let session: { cookie: string; csrf: string };

function cli(cwd: string, args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI, ...args], { cwd, env: { PATH: process.env.PATH ?? "", HOME: root, APPGOV_HOME: join(root, "agent-home"), APPGOV_AGENT: "codex" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("close", (code) => resolve({ code, out }));
  });
}

/** The CLI in an interactive terminal, as the owner runs it: each prompt to type a word is answered with the next of `answers`. */
async function inTerminal(cwd: string, args: string[], answers: string[] = []): Promise<{ code: number | null; out: string }> {
  let out = "";
  let answered = 0;
  const child = Bun.spawn(["node", CLI, ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "", HOME: root, APPGOV_HOME: ownerHome, APPGOV_AGENT: "codex" },
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
  const code = await child.exited;
  return { code, out: out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "") };
}

const apps = () => join(root, "apps");
const copy = (name: string) => join(apps(), name);

async function view<T extends PageModel>(path: string): Promise<T> {
  const res = await fetch(`${stack.url}${path}`, { headers: { cookie: `${PAGE_COOKIE}=${session.cookie}` } });
  return modelOf(await res.text()) as T;
}

async function write(path: string, body: Record<string, unknown> = {}): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(`${stack.url}${path}`, {
    method: "POST",
    headers: { origin: stack.url, "content-type": "application/json", cookie: `${PAGE_COOKIE}=${session.cookie}`, "x-appgov-csrf": session.csrf },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

/** A request with the agent token, past the CLI: what the gateway itself answers to an agent. */
async function asAgent(method: string, path: string, body: Record<string, unknown> = {}): Promise<{ status: number; data: Record<string, unknown> }> {
  const { token } = JSON.parse(readFileSync(join(apps(), ".appgov", "centre.json"), "utf8")) as { token: string };
  const res = await fetch(`${stack.url}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-appgov-api": "1" }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

const edit = (name: string, file: string, text: string) => writeFileSync(join(copy(name), "app", file), text);
const serves = async (name: string) => (await stack.plane.fetch(`${stack.plane.origin}/apps/${name}/`, { headers: { authorization: `Bearer ${FAKE_TOKEN}` } })).status;

beforeAll(async () => {
  stack = await startStack();
  root = mkdtempSync(join(tmpdir(), "appgov-cf-life-"));
  ownerHome = join(root, "owner-home");
  mkdirSync(join(ownerHome, "hosts", "test"), { recursive: true });
  mkdirSync(join(root, "agent-home"), { recursive: true });
  mkdirSync(apps(), { recursive: true });
  writeFileSync(join(ownerHome, "hosts", "test", "owner.json"), JSON.stringify({ url: stack.url, key: stack.ownerKey }), { mode: 0o600 });
  expect((await inTerminal(root, ["--host", stack.url, "login"])).code).toBe(0);
  expect((await inTerminal(root, ["--host", stack.url, "token", "create", "--label", "laptop", "--write", apps()], ["create"])).code).toBe(0);
  expect((await cli(apps(), ["create", "journal"])).code).toBe(0);
  const res = await fetch(`${stack.url}/owner/signin`, { method: "POST", headers: { origin: stack.url, "content-type": "application/json" }, body: JSON.stringify({ key: stack.ownerKey }) });
  const cookie = /__Host-appgov-page=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")![1]!;
  session = { cookie, csrf: await csrfToken(cookie) };
});

afterAll(async () => {
  await stack.close();
  rmSync(root, { recursive: true, force: true });
});

describe("taking an app down and bringing it back, on the Cloudflare edition", () => {
  test("an agent token can do none of the four, at the gateway, and the CLI refuses them without a terminal", async () => {
    for (const verb of ["take-down", "bring-back", "publish-again", "clear"]) {
      expect(await asAgent("POST", `/apps/journal/${verb}`, { confirm: "journal" })).toMatchObject({ status: 403, data: { reason: "owner_required" } });
    }
    const piped = await cli(copy("journal"), ["take-down"]);
    expect(piped.code).toBe(2);
    expect(piped.out).toContain("is the owner's to do, by a person in a terminal");
    expect(stack.plane.find("journal")!.status).toBe("registered");
  });

  test("the owner takes it down in a terminal: PneumaSpace holds it removed, status and the page lead with it, an agent's submit is refused", async () => {
    const id = stack.plane.find("journal")!.id;
    const done = await inTerminal(copy("journal"), ["take-down", "not needed this month"], ["take-down"]);
    expect(done.code).toBe(0);
    expect(done.out).toContain("Taking journal down: it stops serving.");
    expect(stack.plane.find("journal")).toMatchObject({ status: "removed", id });
    expect(await serves("journal")).toBe(404);

    const status = await cli(copy("journal"), ["status"]);
    expect(status.out).toMatch(/^journal: v1 \(not serving\)\nTAKEN DOWN: user:owner took journal down \d{4}-\d\d-\d\d \d\d:\d\d UTC\. It serves nothing and takes no changes; PneumaSpace keeps its stored data/);
    expect(status.out).toContain("PneumaSpace confirmed this");
    const list = await cli(apps(), ["list"]);
    expect(list.out).toMatch(/journal +v1 {2}not serving\n {2}TAKEN DOWN/);

    edit("journal", "index.html", "<h1>while down</h1>\n");
    const submit = await cli(copy("journal"), ["submit", "A change while it is down"]);
    expect(submit.code).not.toBe(0);
    expect(submit.out).toContain("journal is taken down: user:owner took it down on");
    expect(submit.out).toContain("Ask the owner; they bring it back on the Host's page or with bring-back in a terminal.");
    await cli(copy("journal"), ["discard"]);

    const home = await view<HomeModel>("/");
    expect(home.apps.map((card) => card.name)).not.toContain("journal");
    expect(home.down.cards.map((card) => [card.name, card.state, card.address])).toEqual([["journal", "down", null]]);
    const app = await view<AppModel>("/app/journal");
    expect(app).toMatchObject({ state: "down", serving: false, address: null, life: { open: true } });
    expect(app.life!.actions.map((action) => action.verb)).toEqual(["clear", "bring-back"]);
    expect(app.notices[0]!.text).toMatch(/^You took this app down on .+\. It serves nothing and takes no changes; PneumaSpace keeps its stored data\./);
    expect(app.history[0]).toMatchObject({ title: "Taken down", note: "“not needed this month”" });
  });

  test("brought back from the page, it serves again with the data PneumaSpace kept, and changes go through", async () => {
    const id = stack.plane.find("journal")!.id;
    const back = await write("/owner/apps/journal/bring-back");
    expect(back).toMatchObject({ status: 200, data: { standing: "running", note: "journal is back: it serves v1 again, with the data PneumaSpace kept." } });
    expect(stack.plane.find("journal")).toMatchObject({ status: "registered", id });
    expect(await serves("journal")).toBe(200);
    expect((await view<AppModel>("/app/journal")).state).toBe("normal");
    edit("journal", "index.html", "<h1>back again</h1>\n");
    expect((await cli(copy("journal"), ["submit", "A change once it is back"])).out).toContain("published v2");
  });

  test("clearing: never while it serves, never without the name; then the Host forgets it, and PneumaSpace keeps it removed with its data", async () => {
    expect(await write("/owner/apps/journal/clear", { confirm: "journal" })).toMatchObject({ status: 409, data: { reason: "clear_running" } });
    expect((await write("/owner/apps/journal/take-down")).status).toBe(200);

    // What the page says before the name is typed: this plane's tokens may not purge, so the app stays there.
    const app = await view<AppModel>("/app/journal");
    const clear = app.life!.actions.find((action) => action.verb === "clear")!;
    expect(clear.deletes).toEqual(["This Host's record of journal: its versions, its history, and the changes waiting for you, with their previews."]);
    expect(clear.keeps![0]).toBe("journal on PneumaSpace, taken down, with all its stored data: this Host isn't allowed to delete it there. Its name, its app slot and its storage stay taken until you purge it in PneumaSpace's console, as its owner.");
    expect(clear.done).toMatch(/^\/\?done=cleared_kept/);
    expect(app.facts.find((fact) => fact.label === "Clearing")?.value).toBe("leaves it on PneumaSpace, taken down, with its stored data, for its owner to purge in the console");

    expect(await write("/owner/apps/journal/clear", { confirm: "" })).toMatchObject({ status: 400, data: { reason: "confirm_name" } });
    expect(await write("/owner/apps/journal/clear", { confirm: "Journal" })).toMatchObject({ status: 400, data: { reason: "confirm_name" } });
    const cleared = await write("/owner/apps/journal/clear", { confirm: "journal" });
    expect(cleared).toMatchObject({ status: 200, data: { cleared: true, space_holds: true } });

    for (const key of [folderKey("journal"), summaryKey("journal"), viewKey("journal"), plansKey("journal")]) expect(stack.bucket.objects.has(key)).toBe(false);
    expect((await cli(apps(), ["list"])).out).not.toContain("journal");
    expect((await view<HomeModel>("/")).apps.concat((await view<HomeModel>("/")).down.cards).map((card) => card.name)).not.toContain("journal");
    expect(stack.plane.find("journal")!.status).toBe("removed");
    // The page's word afterwards gives the one place to finish.
    expect((await view<HomeModel>("/?done=cleared_kept")).done).toBe(
      "Done. This Host has forgotten the app. PneumaSpace still holds it, taken down, with its stored data: its name, its app slot and its storage stay taken until you purge it in PneumaSpace's console (https://plane.test/), as its owner.",
    );
  });
});

describe("an app PneumaSpace has not finished purging, on the Cloudflare edition", () => {
  test("the stored views and the CLI say it is being purged, not gone; clearing forgets it here and says its name stays taken", async () => {
    expect((await cli(apps(), ["create", "fading"])).code).toBe(0);
    // Its owner removed and purged it in PneumaSpace's console, and the plane has not finished: it lists it `purging`.
    stack.plane.find("fading")!.status = "purging";

    const page = await view<AppModel>("/app/fading?check=1");
    expect(page).toMatchObject({ state: "purging", serving: false, address: null, life: { open: true } });
    expect(page.notices[0]!.text).toContain("PneumaSpace hasn't finished removing this app");
    expect(page.notices[0]!.text).toContain("purge it again in PneumaSpace's console, as its owner");
    expect(page.life!.actions.map((action) => action.verb)).toEqual(["clear"]);
    expect(page.life!.actions[0]!.keeps![0]).toContain("this Host isn't allowed to purge it. Its name stays taken until PneumaSpace finishes");
    expect(page.life!.actions[0]!.done).toMatch(/^\/\?done=cleared_purging/);
    const status = await cli(copy("fading"), ["status"]);
    expect(status.out).toContain("BEING PURGED ON PNEUMASPACE: PneumaSpace has not finished removing fading.");
    expect(status.out).toContain("if PneumaSpace does not finish, its owner purges it again in PneumaSpace's console");
    expect((await cli(apps(), ["list"])).out).toMatch(/fading +v1 {2}not serving\n {2}BEING PURGED ON PNEUMASPACE/);

    const cleared = await inTerminal(copy("fading"), ["clear"], ["fading"]);
    expect(cleared.code).toBe(0);
    expect(cleared.out).toContain("cleared: the centre no longer has fading.");
    expect(cleared.out).toContain("PneumaSpace has not finished purging fading: its name stays taken there until it does.");
    expect(stack.plane.find("fading")!.status).toBe("purging");
    expect((await view<HomeModel>("/?done=cleared_purging")).done).toBe(
      "Done. This Host has forgotten the app. PneumaSpace hasn't finished purging it, and its name stays taken until it does; if it stays so, purge it again in PneumaSpace's console (https://plane.test/), as its owner.",
    );
  });
});

describe("an app that vanished behind the Host's back, on the Cloudflare edition", () => {
  test("the stored views say so once PneumaSpace is asked, without the app's container; a submit is refused; the owner publishes it again", async () => {
    expect((await cli(apps(), ["create", "ghost"])).code).toBe(0);
    const before = stack.plane.find("ghost")!.id;
    stack.plane.vanish("ghost");

    // Asked now: one listing for every app, kept beside the views. The app's Durable Object is not asked.
    const ops = stack.operations.length;
    const page = await view<AppModel>("/app/ghost?check=1");
    expect(stack.operations.length).toBe(ops);
    expect(stack.bucket.objects.has(RUNTIME_KEY)).toBe(true);
    expect(page).toMatchObject({ state: "gone", serving: false, address: null, life: { open: true } });
    expect(page.notices[0]!.text).toContain("This app is not on PneumaSpace.");
    expect(page.life!.actions.map((action) => action.verb)).toEqual(["clear", "publish-again"]);
    expect(page.checked?.href).toBe("/app/ghost?check=1");
    const status = await cli(copy("ghost"), ["status"]);
    expect(status.out).toContain("NOT ON PNEUMASPACE: it has no app named ghost any more, and this centre did not take it down, so the data it stored there is gone");

    edit("ghost", "index.html", "<h1>into nothing</h1>\n");
    const submit = await cli(copy("ghost"), ["submit", "A change to an app that is gone"]);
    expect(submit.out).toContain("PneumaSpace has no app named ghost any more, and this Host did not take it down");
    expect(stack.plane.find("ghost")).toBeUndefined();
    await cli(copy("ghost"), ["discard"]);

    expect(await asAgent("POST", "/apps/ghost/publish-again")).toMatchObject({ status: 403, data: { reason: "owner_required" } });
    const again = await inTerminal(copy("ghost"), ["publish-again"], ["publish-again"]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("ghost is on PneumaSpace again, serving v1, with no stored data");
    expect(stack.plane.find("ghost")!.id).not.toBe(before);
    expect(await serves("ghost")).toBe(200);
    expect((await view<AppModel>("/app/ghost")).state).toBe("normal");
  });

  test("a stored listing newer than an app's view wins over it, and the list says how old it is", async () => {
    stack.plane.vanish("ghost");
    const list = await cli(apps(), ["list", "--check"]);
    expect(list.out).toMatch(/ghost +v1 {2}not serving\n {2}NOT ON PNEUMASPACE/);
    expect(list.out).toMatch(/PneumaSpace confirmed this \d{4}-\d\d-\d\d \d\d:\d\d UTC\. --check asks it now\./);
    // Without asking again, the kept listing still says it, and a fresh plain read takes it from there.
    const home = await view<HomeModel>("/");
    expect(home.apps.find((card) => card.name === "ghost")?.state).toBe("gone");
    expect(home.checked?.href).toBe("/?check=1");
  });
});
