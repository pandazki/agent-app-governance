import { describe, expect, test } from "bun:test";
import { CHANNEL_HEADER, PRINCIPAL_HEADER } from "../src/protocol";
import { handle, LOGIN_FAILURES_ALLOWED, sha256, SESSION_MS, type GatewayDeps } from "../worker/gateway";
import { csrfToken, PAGE_COOKIE, type PageDeps } from "../worker/page";
import { MemoryAuth, modelOf } from "./stack";

// The owner page's door, with the app's Durable Object replaced by a recorder: who may see a view, who may write,
// and from where. test/page-stack.test.ts shows the views themselves on this edition's real answers.

const ORIGIN = "https://host.test";
const OWNER_KEY = `apk_${"1".repeat(64)}`;
const SECRET_APP = "secret-garden";

async function door(now = { value: Date.now() }) {
  const forwarded: { path: string; method: string; principal: unknown; channel: string | null; body: string }[] = [];
  const auth = new MemoryAuth();
  const unreachable = { value: false };
  const page: PageDeps = {
    asset: async (name) => (name === "app.js" ? new Response("console.log('page')") : null),
    versions: async () => new Map([["app.js", "abc123abc123"], ["app.css", "def456def456"]]),
    spaceOrigin: "https://space.test",
    manager: "appgov",
  };
  const deps: GatewayDeps = {
    starter: { cli: "", agents: "" },
    ownerKeyHash: await sha256(OWNER_KEY),
    auth,
    governance: "personal",
    now: () => now.value,
    app: () => ({
      fetch: async (req) => {
        if (unreachable.value) return Response.json({ error: "the Host's container did not start within 180 s", reason: "host_unavailable" }, { status: 502 });
        forwarded.push({ path: new URL(req.url).pathname, method: req.method, principal: JSON.parse(req.headers.get(PRINCIPAL_HEADER)!), channel: req.headers.get(CHANNEL_HEADER), body: await req.text() });
        return Response.json({ status: "published", version: "v4", working_copy: { files: { "app/index.js": "secret source" } } });
      },
    }),
    // As a build before summaries named the owner saved it: the owner's decision was the last change.
    summaries: async () => [{ app_id: SECRET_APP, active_version: "v3", address: "https://space.test/apps/secret-garden/", serving_version: "v3", serves_other_version: false, last_change: { at: new Date(now.value).toISOString(), kind: "decision", outcome: "published", version: "v3", agent: "user:owner", intent: "x" }, pending: [], uncommitted: [] }],
    page,
  };
  type Options = { cookie?: string; origin?: string | null; type?: string; csrf?: string; bearer?: string; site?: string; ip?: string };
  const call = (method: string, path: string, body?: unknown, o: Options = {}) => {
    const headers: Record<string, string> = { "content-type": o.type ?? "application/json", "cf-connecting-ip": o.ip ?? "203.0.113.7" };
    if (o.origin !== null) headers.origin = o.origin ?? ORIGIN;
    if (o.cookie) headers.cookie = `${PAGE_COOKIE}=${o.cookie}`;
    if (o.csrf !== undefined) headers["x-appgov-csrf"] = o.csrf;
    if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
    if (o.site) headers["sec-fetch-site"] = o.site;
    return handle(new Request(`${ORIGIN}${path}`, { method, headers, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) }), deps);
  };
  /** Signs in on the page: the cookie's value and this session's own token. */
  const signIn = async () => {
    const res = await call("POST", "/owner/signin", { key: OWNER_KEY });
    expect(res.status).toBe(200);
    const cookie = /__Host-appgov-page=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")![1]!;
    return { cookie, csrf: await csrfToken(cookie), res };
  };
  return { call, signIn, forwarded, auth, now, unreachable };
}

const WRITES: [string, unknown][] = [
  ["/owner/apps/secret-garden/changes/c1/approve", {}],
  ["/owner/apps/secret-garden/changes/c1/deny", { reason: "no" }],
  ["/owner/apps/secret-garden/changes/c1/preview", {}],
  ["/owner/apps/secret-garden/undo", { to: "v2", from: "v3" }],
  ["/owner/signout", {}],
];

describe("the owner page's door", () => {
  test("without a session every view is the sign-in view, which names no app and counts nothing", async () => {
    const { call, forwarded } = await door();
    // The same view for an app that exists and one that does not, but for the address asked for, which the language links keep.
    const seen = new Map<string, string>();
    for (const [path, other] of [["/", ""], ["/?lang=zh", ""], [`/app/${SECRET_APP}`, "/app/made-up"], [`/app/${SECRET_APP}/change/c1`, "/app/made-up/change/c1"], [`/app/${SECRET_APP}/back/v2`, "/app/made-up/back/v2"]] as const) {
      const res = await call("GET", path);
      expect([path, res.status]).toEqual([path, 401]);
      const html = await res.text();
      const model = modelOf(html);
      expect(model.view).toBe("signin");
      expect(model.search).toEqual([]);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      const anonymous = JSON.stringify({ ...model, now: 0, links: null });
      expect(anonymous).not.toContain(SECRET_APP);
      expect(anonymous).not.toContain("Secret garden");
      if (other) expect(JSON.stringify({ ...modelOf(await (await call("GET", other)).text()), now: 0, links: null })).toBe(anonymous);
      else expect(html).not.toContain(SECRET_APP);
      seen.set(path, anonymous);
    }
    expect(seen.get("/")).toBe(seen.get(`/app/${SECRET_APP}`));
    expect(forwarded).toEqual([]);
  });

  test("the built client is served without a session, and only the files the build writes", async () => {
    const { call } = await door();
    const js = await call("GET", "/assets/app.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(js.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await call("GET", "/assets/icon.svg")).headers.get("content-type")).toBe("image/svg+xml");
    for (const path of ["/assets/app.css", "/assets/secrets.json", "/assets/fonts/x.woff2"]) expect([path, (await call("GET", path)).status]).toEqual([path, 404]);
    // A path that climbs out of /assets/ is not the page's at all: the API answers it, and only with a credential.
    for (const path of ["/assets/../wrangler.json", "/assets/%2e%2e/wrangler.json"]) expect([path, (await call("GET", path)).status]).toEqual([path, 401]);
  });

  test("the owner key gives a session cookie, HttpOnly, Secure, SameSite=Strict, this origin only, for 12 hours; the body holds no secret", async () => {
    const { signIn, call } = await door();
    const { res, cookie, csrf } = await signIn();
    const set = res.headers.get("set-cookie")!;
    expect(set).toMatch(/^__Host-appgov-page=apc_[a-f0-9]{64}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=43200$/);
    expect(await res.text()).not.toContain(cookie);
    const home = await call("GET", "/", undefined, { cookie });
    expect(home.status).toBe(200);
    const model = modelOf(await home.text());
    expect(model.view).toBe("home");
    // A summary without the owner's subject still reads the owner's own decision as theirs.
    expect(model.view === "home" && model.apps[0]!.meta.parts.filter((p) => typeof p === "string").join("")).toBe("Updated  · you");
    // The session's own token is in the view served to it, and nowhere else.
    expect(model.access).toEqual({ kind: "session", csrf });
    expect((await signIn()).csrf).not.toBe(csrf);
  });

  test("a wrong key gives nothing, and wrong keys from one address stop being tried, the CLI's sign-in counting with the page's", async () => {
    const { call } = await door();
    const wrong = await call("POST", "/owner/signin", { key: `apk_${"2".repeat(64)}` });
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as { reason: string }).reason).toBe("wrong_key");
    expect(wrong.headers.get("set-cookie")).toBeNull();
    for (let i = 1; i < LOGIN_FAILURES_ALLOWED - 1; i++) await call("POST", "/owner/signin", { key: "apk_nope" });
    // The last one allowed, through the CLI's route: the count is the same.
    expect((await call("POST", "/auth/login", { key: "apk_nope" })).status).toBe(401);
    const limited = await call("POST", "/owner/signin", { key: OWNER_KEY });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("set-cookie")).toBeNull();
    expect((await call("POST", "/auth/login", { key: OWNER_KEY })).status).toBe(429);
    // Another address still signs in.
    expect((await call("POST", "/owner/signin", { key: OWNER_KEY }, { ip: "198.51.100.9" })).status).toBe(200);
  });

  test("signing in is a write too: from another site, or without JSON, it gives no session", async () => {
    const { call } = await door();
    for (const o of [{ origin: "https://evil.test" }, { origin: null }, { site: "cross-site" }, { type: "text/plain" }, { type: "application/x-www-form-urlencoded" }]) {
      const res = await call("POST", "/owner/signin", { key: OWNER_KEY }, o);
      expect([JSON.stringify(o), res.status >= 400, res.headers.get("set-cookie")]).toEqual([JSON.stringify(o), true, null]);
    }
  });

  test("an agent token is never taken by the page, nor the CLI's session; the page's session is not taken by the API", async () => {
    const { call, signIn, forwarded, auth, now } = await door();
    const agent = `apt_${"3".repeat(64)}`;
    await auth.addToken(await sha256(agent), { id: "t1", label: "laptop", created_at: now.value, expires_at: now.value + 86_400_000, revoked_at: null });
    const cli = `aps_${"4".repeat(64)}`;
    await auth.addSession(await sha256(cli), now.value + SESSION_MS);
    for (const bearer of [agent, cli]) {
      const view = await call("GET", "/", undefined, { bearer });
      expect(modelOf(await view.text()).view).toBe("signin");
      for (const [path, body] of WRITES) {
        const res = await call("POST", path, body, { bearer, csrf: "x" });
        expect([path, res.status, ((await res.json()) as { reason: string }).reason]).toEqual([path, 401, "signed_out"]);
      }
      // As a cookie, either is not a page session.
      expect(modelOf(await (await call("GET", "/", undefined, { cookie: bearer })).text()).view).toBe("signin");
    }
    const { cookie } = await signIn();
    expect((await call("GET", "/apps", undefined, { bearer: cookie })).status).toBe(401);
    expect(forwarded).toEqual([]);
  });

  test("a write in a session must come from this page: this origin, same-origin fetch, JSON, and the session's own token", async () => {
    const { call, signIn, forwarded } = await door();
    const { cookie, csrf } = await signIn();
    const refusals: [string, Parameters<typeof call>[3]][] = [
      ["another origin", { cookie, csrf, origin: "https://evil.test" }],
      ["a look-alike origin", { cookie, csrf, origin: "https://host.test.evil.test" }],
      ["no origin", { cookie, csrf, origin: null }],
      ["a cross-site fetch", { cookie, csrf, site: "cross-site" }],
      ["a same-site fetch", { cookie, csrf, site: "same-site" }],
      ["a form's body", { cookie, csrf, type: "application/x-www-form-urlencoded" }],
      ["no token", { cookie }],
      ["another session's token", { cookie, csrf: await csrfToken(`apc_${"5".repeat(64)}`) }],
      ["an empty token", { cookie, csrf: "" }],
    ];
    for (const [path, body] of WRITES) {
      for (const [what, o] of refusals) {
        const res = await call("POST", path, body, o);
        expect([path, what, res.status >= 400 && res.status < 500]).toEqual([path, what, true]);
      }
    }
    expect(forwarded).toEqual([]);
    // From the page itself, it goes to the app's Durable Object as the owner, marked as made on the page.
    const ok = await call("POST", "/owner/apps/secret-garden/changes/c1/approve", {}, { cookie, csrf, site: "same-origin" });
    expect(ok.status).toBe(200);
    expect(forwarded).toEqual([{ path: "/apps/secret-garden/changes/c1/approve", method: "POST", principal: { kind: "owner" }, channel: "owner-page", body: "{}" }]);
    // The page gets the Host's answer without the app's files the CLI's working copy needs.
    const answer = (await ok.json()) as Record<string, unknown>;
    expect(answer.version).toBe("v4");
    expect(answer.working_copy).toBeUndefined();
    const back = await call("POST", "/owner/apps/secret-garden/undo", { to: "v2", from: "v3", accept_one_way: true }, { cookie, csrf });
    expect(back.status).toBe(200);
    expect(JSON.parse(forwarded.at(-1)!.body)).toEqual({ reason: "undo", to: "v2", from: "v3", accept_one_way: true });
    for (const [path, body] of [["/owner/apps/secret-garden/undo", { to: "../v2", from: "v3" }], ["/owner/apps/Secret/changes/c1/approve", {}], ["/owner/apps/secret-garden/changes/..%2Fx/approve", {}], ["/owner/apps/secret-garden/container/stop", {}]] as const) {
      expect([path, (await call("POST", path, body, { cookie, csrf })).status >= 400]).toEqual([path, true]);
    }
    expect(forwarded).toHaveLength(2);
  });

  test("signing out ends the session: its cookie is cleared, the store forgets it, and its views and token stop working", async () => {
    const { call, signIn, auth } = await door();
    const { cookie, csrf } = await signIn();
    const out = await call("POST", "/owner/signout", {}, { cookie, csrf });
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toBe(`${PAGE_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`);
    expect(await auth.hasSession(await sha256(cookie), Date.now())).toBe(false);
    expect(modelOf(await (await call("GET", "/", undefined, { cookie })).text()).view).toBe("signin");
    expect((await call("POST", "/owner/apps/secret-garden/changes/c1/approve", {}, { cookie, csrf })).status).toBe(401);
  });

  test("a session ends by itself after 12 hours", async () => {
    const { call, signIn, now } = await door();
    const { cookie } = await signIn();
    now.value += SESSION_MS - 1000;
    expect(modelOf(await (await call("GET", "/", undefined, { cookie })).text()).view).toBe("home");
    now.value += 2000;
    expect(modelOf(await (await call("GET", "/", undefined, { cookie })).text()).view).toBe("signin");
  });

  test("when the app's container does not answer, the view says so plainly, with the Host's words under Details", async () => {
    const { call, signIn, unreachable } = await door();
    const { cookie } = await signIn();
    unreachable.value = true;
    const res = await call("GET", `/app/${SECRET_APP}`, undefined, { cookie });
    expect(res.status).toBe(502);
    const model = modelOf(await res.text());
    expect(model.view).toBe("unreadable");
    expect(model.view === "unreadable" && [model.body, model.facts[0]?.value]).toEqual(["The Host couldn't reach this app just now. Reload the page in a minute.", "the Host's container did not start within 180 s"]);
  });

  test("an app the summaries do not list is not asked about: no container starts for a made-up name", async () => {
    const { call, signIn, forwarded } = await door();
    const { cookie } = await signIn();
    for (const path of ["/app/made-up", "/app/made-up/change/c1", "/app/Bad_Name", `/app/${SECRET_APP}/elsewhere`, `/app/${SECRET_APP}/back/latest`]) {
      const res = await call("GET", path, undefined, { cookie });
      expect([path, res.status, modelOf(await res.text()).view]).toEqual([path, 404, "missing"]);
    }
    expect(forwarded).toEqual([]);
  });
});
