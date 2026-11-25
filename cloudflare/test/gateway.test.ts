import { describe, expect, test } from "bun:test";
import { PRINCIPAL_HEADER } from "../src/protocol";
import { handle, sha256, SESSION_MS, type GatewayDeps } from "../worker/gateway";
import { MemoryAuth } from "./stack";

// The Worker's rules on who may do what, with the app's Durable Object replaced by a recorder.

const OWNER_KEY = `apk_${"1".repeat(64)}`;

async function gateway(now = { value: Date.now() }) {
  const forwarded: { path: string; method: string; principal: unknown; op: string | null }[] = [];
  const deps: GatewayDeps = {
    ownerKeyHash: await sha256(OWNER_KEY),
    auth: new MemoryAuth(),
    governance: "personal",
    now: () => now.value,
    app: () => ({
      fetch: async (req) => {
        forwarded.push({ path: new URL(req.url).pathname, method: req.method, principal: JSON.parse(req.headers.get(PRINCIPAL_HEADER)!), op: req.headers.get("x-appgov-op") });
        return Response.json({ ok: true });
      },
    }),
    summaries: async () => [{ app_id: "todo" }],
  };
  const call = (method: string, path: string, { secret, body }: { secret?: string; body?: unknown } = {}) =>
    handle(new Request(`https://host.test${path}`, { method, headers: { ...(secret ? { authorization: `Bearer ${secret}` } : {}), "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), deps);
  const login = async () => ((await (await call("POST", "/auth/login", { body: { key: OWNER_KEY } })).json()) as { session: string }).session;
  const token = async (session: string) => ((await (await call("POST", "/tokens", { secret: session, body: { label: "agent" } })).json()) as { id: string; token: string });
  return { call, login, token, forwarded, now };
}

const APP_ROUTES: [string, string, unknown?][] = [
  ["GET", "/apps"],
  ["POST", "/apps", { name: "todo" }],
  ["GET", "/apps/todo"],
  ["GET", "/apps/todo/history"],
  ["GET", "/apps/todo/folder"],
  ["POST", "/apps/todo/changes", { intent: "x" }],
  ["POST", "/apps/todo/undo", {}],
  ["POST", "/apps/todo/discard", {}],
  ["POST", "/apps/todo/changes/c1/approve", {}],
  ["POST", "/apps/todo/changes/c1/deny", {}],
  ["POST", "/apps/todo/changes/c1/preview", {}],
  ["GET", "/apps/todo/container"],
  ["POST", "/apps/todo/container/stop", {}],
  ["GET", "/tokens"],
  ["POST", "/tokens", {}],
  ["DELETE", "/tokens/t1"],
  ["GET", "/me"],
  ["POST", "/auth/logout", {}],
];

describe("the Worker's gateway", () => {
  test("no route does anything without a credential, or with one it does not know", async () => {
    const { call, forwarded } = await gateway();
    for (const [method, path, body] of APP_ROUTES) {
      for (const secret of [undefined, `apt_${"0".repeat(64)}`, `aps_${"0".repeat(64)}`, OWNER_KEY, "nonsense"]) {
        const res = await call(method, path, { secret, body });
        expect(`${method} ${path} ${res.status}`).toBe(`${method} ${path} 401`);
      }
    }
    expect(forwarded).toEqual([]);
  });

  test("signing in takes the owner key and gives a session; a wrong key gives nothing", async () => {
    const { call, login } = await gateway();
    expect((await call("POST", "/auth/login", { body: { key: `apk_${"2".repeat(64)}` } })).status).toBe(401);
    expect((await call("POST", "/auth/login", { body: {} })).status).toBe(401);
    const session = await login();
    expect(session).toMatch(/^aps_[a-f0-9]{64}$/);
    expect(await (await call("GET", "/me", { secret: session })).json()).toEqual({ principal: { kind: "owner" } });
  });

  test("an agent token creates, submits, reads, fetches, undoes, discards and asks for a preview, as itself", async () => {
    const { call, login, token, forwarded } = await gateway();
    const agent = await token(await login());
    const allowed = APP_ROUTES.filter(([, path]) => !/approve|deny|container|tokens|logout/.test(path));
    for (const [method, path, body] of allowed) expect(`${method} ${path} ${(await call(method, path, { secret: agent.token, body })).status}`).toBe(`${method} ${path} 200`);
    expect(forwarded.length).toBe(allowed.filter(([method, path]) => !(method === "GET" && path === "/apps") && path !== "/me").length);
    expect(forwarded.every((f) => (f.principal as { kind: string; id: string }).kind === "agent" && (f.principal as { id: string }).id === agent.id)).toBe(true);
    expect(forwarded.find((f) => f.path === "/apps")!.op).toBe("create");
  });

  test("an agent token cannot approve, deny, confirm going back past a one-way change, touch the container or the tokens", async () => {
    const { call, login, token, forwarded } = await gateway();
    const agent = await token(await login());
    const refused: [string, string, unknown?][] = [
      ["POST", "/apps/todo/changes/c1/approve", {}],
      ["POST", "/apps/todo/changes/c1/deny", {}],
      ["POST", "/apps/todo/undo", { accept_one_way: true }],
      ["GET", "/apps/todo/container"],
      ["POST", "/apps/todo/container/stop", {}],
      ["GET", "/tokens"],
      ["POST", "/tokens", { label: "more" }],
      ["DELETE", `/tokens/${agent.id}`],
    ];
    for (const [method, path, body] of refused) {
      const res = await call(method, path, { secret: agent.token, body });
      expect(`${method} ${path} ${res.status}`).toBe(`${method} ${path} 403`);
      expect(((await res.json()) as { reason: string }).reason).toBe("owner_required");
    }
    expect(forwarded).toEqual([]);
  });

  test("the owner may do all of it, as the owner", async () => {
    const { call, login, forwarded } = await gateway();
    const session = await login();
    expect((await call("POST", "/apps/todo/changes/c1/approve", { secret: session, body: {} })).status).toBe(200);
    expect((await call("POST", "/apps/todo/undo", { secret: session, body: { accept_one_way: true } })).status).toBe(200);
    expect((await call("POST", "/apps/todo/container/stop", { secret: session, body: {} })).status).toBe(200);
    expect(forwarded.map((f) => f.principal)).toEqual([{ kind: "owner" }, { kind: "owner" }, { kind: "owner" }]);
  });

  test("the app list is answered without the app's Durable Object", async () => {
    const { call, login, forwarded } = await gateway();
    const res = await call("GET", "/apps", { secret: await login() });
    expect(await res.json()).toEqual({ governance: "personal", apps: [{ app_id: "todo" }] });
    expect(forwarded).toEqual([]);
  });

  test("a revoked token, an expired token, a signed-out session and an expired session stop working", async () => {
    const now = { value: Date.now() };
    const { call, login, token } = await gateway(now);
    const session = await login();
    const revoked = await token(session);
    expect((await call("DELETE", `/tokens/${revoked.id}`, { secret: session })).status).toBe(200);
    expect((await call("GET", "/apps/todo", { secret: revoked.token })).status).toBe(401);
    const short = (await (await call("POST", "/tokens", { secret: session, body: { expires_in_days: 1 } })).json()) as { token: string };
    const out = await login();
    expect((await call("POST", "/auth/logout", { secret: out })).status).toBe(200);
    expect((await call("GET", "/me", { secret: out })).status).toBe(401);
    now.value += Math.max(SESSION_MS, 86_400_000) + 1;
    expect((await call("GET", "/apps/todo", { secret: short.token })).status).toBe(401);
    expect((await call("GET", "/me", { secret: session })).status).toBe(401);
  });

  test("names the Host does not take are refused before any Durable Object is asked", async () => {
    const { call, login, forwarded } = await gateway();
    const session = await login();
    for (const path of ["/apps/Todo", "/apps/a_b/history", `/apps/${"a".repeat(31)}`]) expect((await call("GET", path, { secret: session })).status).toBeGreaterThanOrEqual(400);
    expect((await call("POST", "/apps", { secret: session, body: { name: "../x" } })).status).toBe(400);
    expect(forwarded).toEqual([]);
  });

  test("repeated wrong keys from one address are slowed down", async () => {
    const { call } = await gateway();
    for (let i = 0; i < 20; i++) await call("POST", "/auth/login", { body: { key: `apk_${"3".repeat(64)}` } });
    expect((await call("POST", "/auth/login", { body: { key: OWNER_KEY } })).status).toBe(429);
  });
});
