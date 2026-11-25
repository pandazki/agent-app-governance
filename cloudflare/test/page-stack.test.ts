import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppModel, BackModel, ChangeModel, HomeModel, PageModel, Rich } from "../../local/src/page-model";
import { csrfToken, PAGE_COOKIE } from "../worker/page";
import { modelOf, startStack, type Stack } from "./stack";

// The owner page on this edition's own answers: the whole edition on this machine (test/stack.ts), an agent with a
// token making changes through the CLI as in the trial, and the owner on the page. Each view is read from the model
// the Worker put in it, which the client lays out (local/web) as on the local edition.

const CLI = join(import.meta.dir, "..", "bin", "appgov.mjs");
let stack: Stack;
let root: string;
let ownerHome: string;
let session: { cookie: string; csrf: string };
const ids: Record<string, string> = {};

function cli(cwd: string, args: string[], owner = false): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI, ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? "", HOME: root, APPGOV_HOME: owner ? ownerHome : join(root, "agent-home"), APPGOV_AGENT: "codex" },
      stdio: ["ignore", "pipe", "pipe"],
    });
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
const copy = () => join(apps(), "journal");
const edit = (rel: string, change: (text: string) => string) => writeFileSync(join(copy(), rel), change(readFileSync(join(copy(), rel), "utf8")));
const manifest = (change: (m: { capabilities: Record<string, unknown> }) => void) =>
  edit("pneuma-space.json", (text) => {
    const m = JSON.parse(text);
    change(m);
    return `${JSON.stringify(m, null, 2)}\n`;
  });
const words = (rich: Rich) => rich.parts.map((part) => (typeof part === "string" ? part : "{when}")).join("");

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

async function submit(intent: string): Promise<{ code: number | null; out: string; id?: string; version?: string }> {
  const done = await cli(copy(), ["submit", intent]);
  return { ...done, id: /needs_approval (\S+):/.exec(done.out)?.[1], version: /published (v\d+)/.exec(done.out)?.[1] };
}

beforeAll(async () => {
  stack = await startStack();
  root = mkdtempSync(join(tmpdir(), "appgov-cf-page-"));
  ownerHome = join(root, "owner-home");
  mkdirSync(join(ownerHome, "hosts", "test"), { recursive: true });
  mkdirSync(join(root, "agent-home"), { recursive: true });
  mkdirSync(apps(), { recursive: true });
  writeFileSync(join(ownerHome, "hosts", "test", "owner.json"), JSON.stringify({ url: stack.url, key: stack.ownerKey }), { mode: 0o600 });
  // Signing in and making a token are the owner's, by a person in a terminal.
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

describe("the owner page on the Cloudflare edition's answers", () => {
  test("a change the standing rule lets through, with the app's own test", async () => {
    writeFileSync(join(copy(), "tests", "entries.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('an entry keeps its title', () => assert.equal('Dune'.length, 4));\n");
    edit("app/public/style.css", (css) => `${css}\nbody { background: #fafaf7; }\n`);
    expect((await submit("A warmer page")).version).toBe("v2");
  });

  test("a waiting change with the app's own tests: who sent it with which token, what ran, why it waits, where it opens", async () => {
    manifest((m) => (m.capabilities.identity = {}));
    const sent = await submit("Let visitors in without the app knowing who they are");
    expect(sent.code).toBe(2);
    ids.identity = sent.id!;
    const model = await view<ChangeModel>(`/app/journal/change/${ids.identity}`);
    expect(model.view).toBe("change");
    expect(words(model.meta)).toBe("Codex made this change with the token “laptop” · {when}");
    expect(model.checked[0]!.text).toMatch(/^Its tests passed \(\d+ tests, \d+ of them for this app\)$/);
    expect(model.checked.some((row) => row.tone === "caution")).toBe(false);
    expect(model.why).toContain("Anyone with the address could open the app without signing in.");
    expect(model.oneWay).toBeNull();
    expect(model.decision.blocked).toBeNull();
    // The preview opens on PneumaSpace, behind its own sign-in, and this Host takes no pictures.
    expect(model.after.open).toMatch(/^https:\/\/plane\.test\/apps\/journal-pv[a-z0-9]+\/$/);
    expect(model.opensElsewhere).toBe("The app and its previews open on PneumaSpace, where you sign in separately.");
    // No picture is ever taken here, so the views leave out the frames one would fill.
    expect(model.picturesNever).toBe(true);
    expect(model.before.shot?.caption).toBe("No pictures on this Host. Use Open to see the app.");
    expect(model.facts.find((fact) => fact.label === "Credential")?.value).toMatch(/^agent token "laptop" \(t[0-9a-f]+\)$/);
    expect(model.access.kind).toBe("session");
    // In Chinese, the page's own words are Chinese; the agent's words and the token's label stay as they were written.
    const zh = await view<ChangeModel>(`/app/journal/change/${ids.identity}?lang=zh`);
    expect(words(zh.meta)).toBe("Codex 用令牌“laptop”做了这个改动 · {when}");
    expect(zh.opensElsewhere).toBe("应用和它的预览在 PneumaSpace 上打开，那里需要另外登录。");
    expect(zh.checked[0]!.text).toMatch(/^测试通过（共 \d+ 个，其中 \d+ 个是这个应用自己的）$/);
  });

  test("the list of apps comes from the summaries, with no container started", async () => {
    await stack.dropContainer();
    const started = stack.starts();
    const home = await view<HomeModel>("/");
    expect(stack.starts()).toBe(started);
    expect(home.apps.map((app) => [app.name, app.state])).toEqual([["journal", "waiting"]]);
    expect(home.waiting).toHaveLength(1);
    expect(words(home.waiting[0]!.meta)).toBe("Codex, with the token “laptop” · {when}");
    // The summary carries the waiting change's checks: the meter says what ran, not "not checked".
    expect(home.waiting[0]!.signalLabel).toBe("Checked and tried out");
    expect(home.apps[0]!.shot.caption).toBe("No pictures on this Host. Use Open to see the app.");
    expect(home.facts.find((fact) => fact.label === "Pictures")?.value).toBe("none: this edition takes no pictures");
  });

  test("letting it go live on the page: through the app's container, as the owner, marked as made on the page", async () => {
    const decided = await write(`/owner/apps/journal/changes/${ids.identity}/approve`);
    expect(decided.status).toBe(200);
    expect(decided.data.version).toBe("v3");
    expect(decided.data.working_copy).toBeUndefined();
    const app = await view<AppModel>("/app/journal?done=live");
    expect(app.done).toBe("It's live now.");
    const row = app.history.find((r) => r.title === "“Let visitors in without the app knowing who they are”")!;
    expect(row.pill).toEqual({ label: "Running now", tone: "green" });
    // The row names the agent that made the change and its token; that you let it through is what stood behind it.
    expect(words(row.who)).toBe("Codex, with the token “laptop” · {when}");
    expect(words(row.standing!)).toContain("you confirmed");
    expect(row.facts.find((fact) => fact.label === "Came through")?.value).toBe("owner-page");
    expect(app.opensElsewhere).not.toBeNull();
    const history = (await cli(copy(), ["history"])).out;
    expect(history).toMatch(/decision published -> v3 by user:owner \(owner session\) \[owner\]/);
  });

  test("a one-way change none of the app's own tests checked: the warning, the mark, and what the rules say is lost; saying no", async () => {
    expect((await cli(copy(), ["fetch"])).code).toBe(0);
    const kept = Object.fromEntries(["tests/server.test.mjs", "tests/entries.test.mjs", "app/server.mjs"].map((rel) => [rel, readFileSync(join(copy(), rel), "utf8")]));
    edit("tests/server.test.mjs", (text) => text.replaceAll("test('", "test.skip('"));
    edit("tests/entries.test.mjs", (text) => text.replaceAll("test('", "test.skip('"));
    edit("app/server.mjs", (text) => `${text}\nexport const cleanup = "DROP TABLE entries";\n`);
    const sent = await submit("Start the journal over");
    expect(sent.code).toBe(2);
    ids.oneWay = sent.id!;
    const model = await view<ChangeModel>(`/app/journal/change/${ids.oneWay}`);
    expect(model.checked[0]).toEqual({ text: "No tests ran for this change: only its preview checked it.", tone: "caution" });
    expect(model.oneWay?.title).toBe("This one can't be taken back");
    expect(model.oneWay?.body).toBe("If you go back later, only the app goes back. The data this change removes stays removed, and the older version may not work with your data.");
    expect(model.oneWay?.why).toBe('In the words of this Host\'s rules: app/server.mjs now runs "DROP", which deletes or rewrites data that is already stored.');
    // A test run with no test in it is not "checked".
    expect(model.decision.signalLabel).toBe("Tried out");
    expect(model.decision.oneWay).toBe(true);
    expect(model.decision.check).not.toBeNull();
    const zh = await view<ChangeModel>(`/app/journal/change/${ids.oneWay}?lang=zh`);
    expect(zh.checked[0]!.text).toBe("这次改动没有运行任何测试，只有预览检查过它。");
    expect(zh.oneWay?.title).toBe("这个改动无法撤回");

    const denied = await write(`/owner/apps/journal/changes/${ids.oneWay}/deny`, { reason: "keep my entries" });
    expect(denied.status).toBe(200);
    const app = await view<AppModel>("/app/journal?done=no");
    const row = app.history.find((r) => r.title === "“Start the journal over”")!;
    expect(words(row.standing!)).toBe("You said no · nothing changed");
    expect(words(row.who)).toBe("Codex, with the token “laptop” · {when}");
    expect((await view<ChangeModel>(`/app/journal/change/${ids.oneWay}`)).gone).toBe(true);
    for (const [rel, text] of Object.entries(kept)) writeFileSync(join(copy(), rel), text);
  });

  test("going back on the page: what the versions undone left in stored data, before and after", async () => {
    edit("app/server.mjs", (text) => `${text}\nexport const migration = "ALTER TABLE entries ADD COLUMN mood TEXT";\n`);
    const sent = await submit("Entries get a mood");
    expect(sent.version).toBe("v4");
    const back = await view<BackModel>("/app/journal/back/v3");
    expect(back.kind).toBe("plan");
    expect(back.from).toBe("v4");
    expect(words(back.data!)).toBe("Your stored data stays as it is, but the version you go back to may not show all of it: the changes you undo write data in ways it doesn't (ALTER TABLE entries ADD COLUMN mood TEXT).");
    expect(back.afterNote).toBe(words(back.data!));
    const zh = await view<BackModel>("/app/journal/back/v3?lang=zh");
    expect(words(zh.data!)).toBe("已存的数据保持不变，但要回到的版本可能显示不全：被撤销的改动以它没有的方式写入了数据（ALTER TABLE entries ADD COLUMN mood TEXT）。");

    // A change that waits on v4 while the owner goes back to v3.
    expect((await cli(copy(), ["fetch"])).code).toBe(0);
    manifest((m) => delete m.capabilities.kv);
    edit("app/server.mjs", (text) => `${text}\n// keeps entries elsewhere\n`);
    const waiting = await submit("Keep entries somewhere else");
    expect(waiting.code).toBe(2);
    ids.behind = waiting.id!;
    expect((await view<ChangeModel>(`/app/journal/change/${ids.behind}`)).decision.blocked).toBeNull();
    // The change waits as a draft of its own: the centre holds no edits that would stop going back, and the page calls none work in progress.
    const waitingApp = await view<AppModel>("/app/journal");
    expect(waitingApp.notices).toEqual([]);
    expect(waitingApp.facts.some((fact) => fact.label === "Not submitted")).toBe(false);
    expect((await view<BackModel>("/app/journal/back/v3")).blocked).toBeNull();

    const gone = await write("/owner/apps/journal/undo", { to: "v3", from: "v4" });
    expect(gone.status).toBe(200);
    expect(gone.data.active_version).toBe("v3");
    expect(String(gone.data.data_left)).toContain("ALTER TABLE entries ADD COLUMN mood TEXT");
    const app = await view<AppModel>("/app/journal?done=back");
    expect(app.done).toBe("Done. The app is back to that version.");
    const row = app.history[0]!;
    expect(row.badge).toBe("undo");
    expect(row.facts.find((fact) => fact.label === "Came through")?.value).toBe("owner-page");
    // A stale plan is refused, as on the local edition.
    expect((await write("/owner/apps/journal/undo", { to: "v2", from: "v4" })).data.reason).toBe("plan_changed");
  });

  test("a change made on a version the app has since left cannot go live, and says why; saying no still works", async () => {
    const model = await view<ChangeModel>(`/app/journal/change/${ids.behind}`);
    expect(model.gone).toBe(false);
    expect(model.decision.blocked).toBe("This can't go live as it is: it was made on an earlier version, and the app has changed since. You can say no, and ask your agent to make it again on the current version.");
    expect((await view<ChangeModel>(`/app/journal/change/${ids.behind}?lang=zh`)).decision.blocked).toBe("它不能就这样上线：它是在旧版本上做的，之后应用又变了。你可以拒绝它，再让 AI 助手在当前版本上重做一次。");
    expect((await write(`/owner/apps/journal/changes/${ids.behind}/deny`)).status).toBe(200);
  });

  test("a change that does not wait (any more) says so", async () => {
    const gone = await view<ChangeModel>("/app/journal/change/no-such-change");
    expect([gone.view, gone.gone, gone.intent]).toEqual(["change", true, "This change isn't waiting any more."]);
  });
});
