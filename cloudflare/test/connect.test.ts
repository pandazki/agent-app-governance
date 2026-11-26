import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EDITION } from "../src/edition";
import { PRINCIPAL_HEADER } from "../src/protocol";
import { addressKey, CODE_ALPHABET, CODE_FAILURES_PER_ADDRESS, CODE_MS, CODES_WAITING, connectScript, makeCode, normalizeCode, showCode } from "../worker/connect";
import { handle, sha256, type GatewayDeps } from "../worker/gateway";
import { csrfToken, PAGE_COOKIE, type PageDeps } from "../worker/page";
import { MemoryAuth, modelOf, startStack } from "./stack";
import type { HomeModel } from "../../local/src/page-model";

// Connecting an agent from the owner page with a one-time code (worker/connect.ts): the code's life, the trade for
// an agent token and what that token may do, the limits on guessing, revoking, and the whole path an agent takes from
// the one command, in an empty directory, against the edition on this machine.

const ORIGIN = "https://host.test";
const OWNER_KEY = `apk_${"2".repeat(64)}`;
const CLI = "// the centre's CLI\n";

async function door(now = { value: Date.now() }) {
  const auth = new MemoryAuth();
  const forwarded: { path: string; principal: unknown }[] = [];
  const page: PageDeps = { asset: async () => null, versions: async () => new Map(), spaceOrigin: "https://space.test", manager: "appgov" };
  const deps: GatewayDeps = {
    starter: { cli: CLI, agents: "# Apps kept by an appgov centre\nThe centre is at {{CENTRE}}.\n" },
    ownerKeyHash: await sha256(OWNER_KEY),
    auth,
    governance: "personal",
    now: () => now.value,
    app: () => ({
      fetch: async (req) => {
        forwarded.push({ path: new URL(req.url).pathname, principal: JSON.parse(req.headers.get(PRINCIPAL_HEADER)!) });
        return Response.json({ ok: true });
      },
    }),
    summaries: async () => [],
    page,
  };
  type Options = { cookie?: string; csrf?: string; origin?: string | null; bearer?: string; ip?: string; site?: string };
  const call = (method: string, path: string, body?: unknown, o: Options = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json", "cf-connecting-ip": o.ip ?? "198.51.100.4" };
    if (o.origin) headers.origin = o.origin;
    if (o.cookie) headers.cookie = `${PAGE_COOKIE}=${o.cookie}`;
    if (o.csrf !== undefined) headers["x-appgov-csrf"] = o.csrf;
    if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
    if (o.site) headers["sec-fetch-site"] = o.site;
    return handle(new Request(`${ORIGIN}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), deps);
  };
  const signIn = async () => {
    const res = await call("POST", "/owner/signin", { key: OWNER_KEY }, { origin: ORIGIN });
    const cookie = /__Host-appgov-page=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")![1]!;
    return { cookie, csrf: await csrfToken(cookie) };
  };
  /** The owner's page write, in a session, from the page itself. */
  const owner = async (path: string, body: unknown = {}) => {
    const session = await signIn();
    return call("POST", path, body, { cookie: session.cookie, csrf: session.csrf, origin: ORIGIN });
  };
  const makeCodeFor = async (label = "MacBook") => (await (await owner("/owner/connect", { label })).json()) as { id: string; code: string; expires_at: string; command: string };
  const trade = (code: unknown, o: Options = {}) => call("POST", "/connect", { code, agent: "codex" }, o);
  return { call, signIn, owner, makeCodeFor, trade, auth, now, forwarded };
}

describe("one-time codes", () => {
  test("a code is 12 letters and digits that cannot be misread, shown in groups of four, and read back however it is typed", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const code = makeCode();
      expect(code).toMatch(/^[2-9A-HJ-KMNP-Z]{12}$/);
      seen.add(code);
    }
    expect(seen.size).toBe(400);
    expect(CODE_ALPHABET).not.toMatch(/[01ILO]/);
    expect(showCode("ABCD2345EFGH")).toBe("ABCD-2345-EFGH");
    expect(normalizeCode("abcd-2345-efgh")).toBe("ABCD2345EFGH");
    expect(normalizeCode(" ABCD 2345 EFGH ")).toBe("ABCD2345EFGH");
    for (const bad of ["ABCD-2345-EFG", "ABCD-2345-EFGHJ", "ABCD-O345-EFGH", "ABCD-1345-EFGH", 123456789012, null]) expect(normalizeCode(bad)).toBeNull();
  });

  test("the owner makes a code on the page; it waits ten minutes, and the page can ask what became of it", async () => {
    const d = await door();
    const made = await d.makeCodeFor("MacBook");
    expect(made.code).toMatch(/^[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}$/);
    expect(made.command).toBe(`curl -fsSo .appgov-connect.cjs ${ORIGIN}/connect && node .appgov-connect.cjs ${made.code}`);
    expect(Date.parse(made.expires_at) - d.now.value).toBe(CODE_MS);
    const state = await (await d.owner(`/owner/connect/${made.id}/state`)).json();
    expect(state).toEqual({ state: "waiting", expires_at: d.now.value + CODE_MS });
    // A connection needs a name.
    expect((await d.owner("/owner/connect", { label: "  " })).status).toBe(400);
  });

  test("a code trades once for an agent token named as the owner named the connection; a second trade gets nothing", async () => {
    const d = await door();
    const made = await d.makeCodeFor("MacBook");
    const first = await d.trade(made.code.toLowerCase());
    expect(first.status).toBe(201);
    const got = (await first.json()) as { token: string; id: string; label: string; via: string; agent: string; host_url: string; expires_at: number };
    expect(got.token).toMatch(/^apt_[a-f0-9]{64}$/);
    expect(got).toMatchObject({ label: "MacBook", via: "code", agent: "codex", host_url: ORIGIN });
    expect(got.expires_at - d.now.value).toBe(90 * 86_400_000);
    const again = await d.trade(made.code);
    expect(again.status).toBe(401);
    expect(((await again.json()) as { reason: string }).reason).toBe("bad_code");
    expect(await (await d.owner(`/owner/connect/${made.id}/state`)).json()).toEqual({ state: "used", label: "MacBook", token_id: got.id });
    // Only the hash of the code and of the token was kept.
    const kept = JSON.stringify([...(d.auth as unknown as { kv: { map: Map<string, unknown> } }).kv.map.entries()]);
    expect(kept).not.toContain(made.code.replaceAll("-", ""));
    expect(kept).not.toContain(got.token);
  });

  test("a code past its ten minutes, or closed by the owner, trades for nothing", async () => {
    const d = await door();
    const late = await d.makeCodeFor("old");
    const closed = await d.makeCodeFor("closed");
    expect(await (await d.owner(`/owner/connect/${closed.id}/cancel`)).json()).toEqual({ closed: true });
    expect((await d.trade(closed.code)).status).toBe(401);
    expect(await (await d.owner(`/owner/connect/${closed.id}/state`)).json()).toEqual({ state: "gone" });
    // Closing what is no longer waiting closes nothing: a used code stays used.
    const used = await d.makeCodeFor("used");
    expect((await d.trade(used.code)).status).toBe(201);
    expect(await (await d.owner(`/owner/connect/${used.id}/cancel`)).json()).toEqual({ closed: false });
    expect(await (await d.owner(`/owner/connect/${used.id}/state`)).json()).toMatchObject({ state: "used", label: "used" });
    d.now.value += CODE_MS;
    expect(await (await d.owner(`/owner/connect/${late.id}/state`)).json()).toEqual({ state: "expired" });
    expect((await d.trade(late.code)).status).toBe(401);
    expect((await d.auth.listTokens()).map((t) => t.label)).toEqual(["used"]);
  });

  test(`at most ${CODES_WAITING} codes wait at once; one that ends makes room`, async () => {
    const d = await door();
    const made = [];
    for (let i = 0; i < CODES_WAITING; i++) made.push(await d.makeCodeFor(`c${i}`));
    const refused = await d.owner("/owner/connect", { label: "one more" });
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { reason: string }).reason).toBe("too_many_codes");
    await d.owner(`/owner/connect/${made[0]!.id}/cancel`);
    expect((await d.owner("/owner/connect", { label: "one more" })).status).toBe(201);
  });
});

describe("what a traded token may do", () => {
  test("exactly an agent token's rights: it works with apps, and cannot make tokens or codes, list or revoke connections, or decide", async () => {
    const d = await door();
    const { token } = (await (await d.trade((await d.makeCodeFor()).code)).json()) as { token: string };
    expect((await d.call("GET", "/apps", undefined, { bearer: token })).status).toBe(200);
    expect((await d.call("POST", "/apps/todo/changes", { intent: "x" }, { bearer: token })).status).toBe(200);
    expect(d.forwarded.at(-1)?.principal).toMatchObject({ kind: "agent", label: "MacBook" });
    for (const [method, path] of [["POST", "/tokens"], ["GET", "/tokens"], ["DELETE", "/tokens/t000000000000"], ["POST", "/apps/todo/changes/c1/approve"], ["POST", "/apps/todo/take-down"]] as const) {
      expect((await d.call(method, path, {}, { bearer: token })).status).toBe(403);
    }
    // The page's routes take no Authorization header at all: with the token and no session, nothing is made.
    for (const path of ["/owner/connect", "/owner/tokens/t000000000000/revoke"]) {
      expect((await d.call("POST", path, { label: "x" }, { bearer: token, origin: ORIGIN })).status).toBe(401);
    }
  });

  test("the page's code and revoke routes follow its rules: a session, its own token, and this origin", async () => {
    const d = await door();
    const s = await d.signIn();
    expect((await d.call("POST", "/owner/connect", { label: "x" }, { origin: ORIGIN })).status).toBe(401);
    expect((await d.call("POST", "/owner/connect", { label: "x" }, { cookie: s.cookie, origin: ORIGIN })).status).toBe(403);
    expect((await d.call("POST", "/owner/connect", { label: "x" }, { cookie: s.cookie, csrf: s.csrf, origin: "https://elsewhere.test" })).status).toBe(403);
    expect((await d.call("POST", "/owner/connect", { label: "x" }, { cookie: s.cookie, csrf: s.csrf, origin: ORIGIN, site: "cross-site" })).status).toBe(403);
    expect((await d.call("POST", "/owner/connect", { label: "x" }, { cookie: s.cookie, csrf: s.csrf, origin: ORIGIN })).status).toBe(201);
  });

  test("a web page cannot spend codes: the trade refuses what only a browser sends", async () => {
    const d = await door();
    const made = await d.makeCodeFor();
    expect((await d.trade(made.code, { origin: "https://elsewhere.test" })).status).toBe(403);
    expect((await d.trade(made.code, { site: "cross-site" })).status).toBe(403);
    expect((await d.trade(made.code)).status).toBe(201);
  });

  test("revoking a connection on the page stops its token at once", async () => {
    const d = await door();
    const got = (await (await d.trade((await d.makeCodeFor()).code)).json()) as { token: string; id: string };
    expect((await d.call("GET", "/apps", undefined, { bearer: got.token })).status).toBe(200);
    expect(await (await d.owner(`/owner/tokens/${got.id}/revoke`)).json()).toEqual({ revoked: got.id });
    expect((await d.call("GET", "/apps", undefined, { bearer: got.token })).status).toBe(401);
    expect((await d.owner("/owner/tokens/t000000000000/revoke")).status).toBe(404);
  });
});

describe("the runbook's checks of an install (AGENTS.md)", () => {
  test("without a credential: the page asks for the owner's sign-in, the API refuses, and the connect script answers", async () => {
    const d = await door();
    expect((await d.call("GET", "/")).status).toBe(401);
    expect((await d.call("GET", "/apps")).status).toBe(401);
    const script = await d.call("GET", "/connect");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await script.text()).toBe(connectScript(ORIGIN, CLI));
  });
});

describe("guessing codes", () => {
  test(`${CODE_FAILURES_PER_ADDRESS} wrong codes from one address stop that address for ten minutes, even with the right code`, async () => {
    const d = await door();
    const made = await d.makeCodeFor();
    for (let i = 0; i < CODE_FAILURES_PER_ADDRESS; i++) expect((await d.trade("ZZZZ-ZZZZ-ZZZZ", { ip: "192.0.2.9" })).status).toBe(401);
    const stopped = await d.trade(made.code, { ip: "192.0.2.9" });
    expect(stopped.status).toBe(429);
    expect(((await stopped.json()) as { reason: string }).reason).toBe("too_many_attempts");
    // Another address is not stopped, and the code was not spent by the refused attempt.
    expect((await d.trade(made.code, { ip: "192.0.2.10" })).status).toBe(201);
    d.now.value += 600_000;
    expect((await d.trade("ZZZZ-ZZZZ-ZZZZ", { ip: "192.0.2.9" })).status).toBe(401);
  });

  test("an IPv6 address is counted with its /64, so a new address from the same network does not start again", async () => {
    expect(addressKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:db8:1:2::ffff")).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:0db8:0001:0002:0:0:0:9")).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(addressKey("203.0.113.5")).toBe("203.0.113.5");
    const d = await door();
    for (let i = 0; i < CODE_FAILURES_PER_ADDRESS; i++) await d.trade("ZZZZ-ZZZZ-ZZZZ", { ip: `2001:db8:1:2::${(i + 1).toString(16)}` });
    expect((await d.trade("ZZZZ-ZZZZ-ZZZZ", { ip: "2001:db8:1:2:ffff::7" })).status).toBe(429);
    expect((await d.trade("ZZZZ-ZZZZ-ZZZZ", { ip: "2001:db8:1:3::1" })).status).toBe(401);
  });

  test("no count is shared by every address: wrong codes from many addresses do not stop the owner's own trade", async () => {
    const d = await door();
    const made = await d.makeCodeFor();
    for (let i = 0; i < 300; i++) await d.trade("not a code", { ip: `10.0.${Math.floor(i / 10)}.${i % 10}` });
    expect((await d.trade(made.code, { ip: "192.0.2.77" })).status).toBe(201);
  });

  test("a burst of wrong codes sent at once is counted exactly: the 21st is refused however they arrive", async () => {
    const d = await door();
    const made = await d.makeCodeFor();
    const burst = await Promise.all(Array.from({ length: CODE_FAILURES_PER_ADDRESS + 5 }, () => d.trade("ZZZZ-ZZZZ-ZZZZ", { ip: "192.0.2.50" })));
    expect(burst.filter((r) => r.status === 401).length).toBe(CODE_FAILURES_PER_ADDRESS);
    expect(burst.filter((r) => r.status === 429).length).toBe(5);
    expect((await d.trade(made.code, { ip: "192.0.2.50" })).status).toBe(429);
  });
});

describe("the home view lists connections and the first steps", () => {
  test("no apps and no connection: connecting is the step to do; once connected, asking for an app is; the token never reaches the page", async () => {
    const d = await door();
    const s = await d.signIn();
    const home = async () => modelOf(await (await d.call("GET", "/?lang=en", undefined, { cookie: s.cookie })).text()) as HomeModel;
    const before = await home();
    expect(before.start?.steps.map((step) => [step.title, step.state])).toEqual([["Connect my AI assistant", "now"], ["Ask it for your first app", "later"]]);
    expect(before.connect).toMatchObject({ url: "/owner/connect", stateUrl: "/owner/connect/{id}/state", cancelUrl: "/owner/connect/{id}/cancel" });
    expect(before.connections).toEqual([]);
    expect(before.hint).toBeNull();
    const got = (await (await d.trade((await d.makeCodeFor("MacBook")).code)).json()) as { token: string; id: string };
    const html = await (await d.call("GET", "/?lang=en", undefined, { cookie: s.cookie })).text();
    expect(html).not.toContain(got.token);
    const after = modelOf(html) as HomeModel;
    expect(after.start?.steps.map((step) => [step.state, step.doneNote])).toEqual([["done", "Connected: MacBook"], ["now", null]]);
    expect(after.connections?.map((c) => [c.id, c.label, c.revokeUrl])).toEqual([[got.id, "MacBook", `/owner/tokens/${got.id}/revoke`]]);
    expect(after.connections?.[0]?.meta.parts[0]).toBe("Codex · connected ");
  });
});

/** A child process, without blocking this one: the edition's server runs in this process. */
function run(command: string, cwd: string, env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], { cwd, env: { PATH: process.env.PATH ?? "", ...env } });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const filesIn = (dir: string, prefix = ""): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? filesIn(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]))
    .sort();

describe("an agent with only the sentence, in an empty directory", () => {
  test("the one command leaves what token create --write leaves, and nothing else; the token is never printed and the code dies", async () => {
    const stack = await startStack();
    const root = mkdtempSync(join(tmpdir(), "appgov-connect-"));
    try {
      const signin = await fetch(`${stack.url}/owner/signin`, { method: "POST", headers: { origin: stack.url, "content-type": "application/json" }, body: JSON.stringify({ key: stack.ownerKey }) });
      const cookie = /__Host-appgov-page=([^;]*)/.exec(signin.headers.get("set-cookie") ?? "")![1]!;
      const headers = { origin: stack.url, "content-type": "application/json", cookie: `${PAGE_COOKIE}=${cookie}`, "x-appgov-csrf": await csrfToken(cookie) };
      const made = (await (await fetch(`${stack.url}/owner/connect`, { method: "POST", headers, body: JSON.stringify({ label: "MacBook" }) })).json()) as { command: string };

      // What the command fetches is the script, from this Host only, holding the Host's CLI and nothing secret.
      const script = await (await fetch(`${stack.url}/connect`)).text();
      const cli = readFileSync(join(EDITION, "bin", "appgov.mjs"), "utf8");
      expect(script).toBe(connectScript(stack.url, cli));
      expect(script).not.toMatch(/apt_[a-f0-9]{64}|aps_|apc_|apk_[a-f0-9]{64}/);

      const dir = join(root, "apps");
      mkdirSync(dir);
      const connected = await run(made.command, dir, { HOME: root, CLAUDECODE: "1" });
      expect(connected.code).toBe(0);
      expect(filesIn(dir)).toEqual([".appgov/appgov.mjs", ".appgov/centre.json", "AGENTS.md", "CLAUDE.md"]);
      const centre = JSON.parse(readFileSync(join(dir, ".appgov", "centre.json"), "utf8")) as Record<string, string>;
      expect(Object.keys(centre).sort()).toEqual(["token", "url"]);
      expect(centre.url).toBe(stack.url);
      expect(centre.token).toMatch(/^apt_[a-f0-9]{64}$/);
      expect(statSync(join(dir, ".appgov", "centre.json")).mode & 0o777).toBe(0o600);
      expect(connected.out).not.toContain(centre.token!);
      expect(connected.out).toContain('as "MacBook"');
      expect(readFileSync(join(dir, ".appgov", "appgov.mjs"), "utf8")).toBe(cli);
      expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
      const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
      expect(agents).toContain(`The centre is at ${stack.url}.`);
      expect(agents).toContain("Never print it");

      // The directory works as one token create --write made: the agent lists and creates apps with its own token.
      const listed = await run("node .appgov/appgov.mjs list", dir, { HOME: root });
      expect(listed.code).toBe(0);
      expect(listed.out).toContain("no apps yet");
      const tokens = await stack.auth.listTokens();
      expect(tokens.map((t) => [t.label, t.via, t.agent])).toEqual([["MacBook", "code", "claude-code"]]);

      // The code is spent: another directory gets nothing, and is left as it was.
      const other = join(root, "other");
      mkdirSync(other);
      writeFileSync(join(other, "notes.txt"), "mine\n");
      const again = await run(made.command, other, { HOME: root });
      expect(again.code).not.toBe(0);
      expect(again.out).toContain("Ask the user for a new code");
      expect(filesIn(other)).toEqual(["notes.txt"]);
      // Reconnecting a directory whose token was refused: a CLI already there is put back when the trade fails.
      const again2 = join(root, "again");
      mkdirSync(join(again2, ".appgov"), { recursive: true });
      writeFileSync(join(again2, ".appgov", "appgov.mjs"), "// the CLI it had\n");
      expect((await run(made.command, again2, { HOME: root })).code).not.toBe(0);
      expect(readFileSync(join(again2, ".appgov", "appgov.mjs"), "utf8")).toBe("// the CLI it had\n");
      expect(filesIn(again2)).toEqual([".appgov/appgov.mjs"]);
      // A download that fails stops the command with curl's error and a failing exit, and leaves nothing.
      const offline = join(root, "offline");
      mkdirSync(offline);
      const unreachable = await run(made.command.replace(stack.url, "http://127.0.0.1:9"), offline, { HOME: root });
      expect(unreachable.code).not.toBe(0);
      expect(unreachable.out).toContain("curl:");
      expect(filesIn(offline)).toEqual([]);
      // A directory that is connected already is not touched.
      const twice = await run(made.command, dir, { HOME: root });
      expect(twice.code).not.toBe(0);
      expect(twice.out).toContain("exists already");
      expect(JSON.parse(readFileSync(join(dir, ".appgov", "centre.json"), "utf8")).token).toBe(centre.token);
      expect(existsSync(join(other, ".appgov"))).toBe(false);
    } finally {
      await stack.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
