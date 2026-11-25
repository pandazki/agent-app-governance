import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Previews } from "../../host/src/preview";
import { CfSpace, packageApp } from "../src/space-cf";
import { FAKE_TOKEN, FakePlane } from "./fake-plane";

const TEMPLATE = join(import.meta.dir, "..", "template");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function appDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "space-cf-"));
  dirs.push(dir);
  cpSync(TEMPLATE, dir, { recursive: true });
  return dir;
}

function setup() {
  const plane = new FakePlane();
  const space = new CfSpace({ origin: plane.origin, token: FAKE_TOKEN, template: TEMPLATE, fetch: plane.fetch });
  return { plane, space };
}

const MANAGER = { name: "appgov", url: "https://host.test/" };

describe("the Cloudflare plane as the Host's runtime", () => {
  test("a package is the manifest and the files under app/, and the same files give the same digest", () => {
    const dir = appDir();
    const a = packageApp(dir);
    expect(a.pkg.manifest.contract).toBe("pneuma-space.cf/1");
    expect(a.pkg.files.map((f) => f.path)).toEqual(["public/app.js", "public/icon.svg", "public/index.html", "public/style.css", "server.mjs"]);
    expect(packageApp(dir).digest).toBe(a.digest);
    writeFileSync(join(dir, "tests", "extra.test.mjs"), "// not published\n");
    expect(packageApp(dir).digest).toBe(a.digest);
    writeFileSync(join(dir, "app", "public", "style.css"), "body{}\n");
    expect(packageApp(dir).digest).not.toBe(a.digest);
  });

  test("a release creates a managed app, uploads on a ticket and releases, each with the manager's header", async () => {
    const { plane, space } = setup();
    const result = await space.publish("todo", appDir(), { manager: MANAGER });
    expect(result.code).toBe(0);
    expect(result.app).toBe("a1");
    const app = plane.apps[0]!;
    expect(app).toMatchObject({ name: "todo", status: "registered", expiresAt: null, manager: { name: "appgov", url: "https://host.test/" }, current: 1 });
    const named = plane.calls.filter((c) => c.method === "POST");
    expect(named.map((c) => c.path.replace(/a1/, ":id"))).toEqual(["/tenants/t1/apps", "/apps/:id/uploads", "/apps/:id/releases"]);
    expect(named.every((c) => c.manager === "appgov")).toBe(true);
    expect(await space.app("todo")).toEqual({ name: "todo", status: "registered", expiresAt: null, manager: { name: "appgov", url: "https://host.test/" } });
  });

  test("a preview is an ephemeral app: ephemeral on create, upload and release; discarded by its id", async () => {
    const { plane, space } = setup();
    const result = await space.publish("todo-pvab12", appDir(), { ephemeral: { ttlSeconds: 600 }, manager: MANAGER });
    expect(result.code).toBe(0);
    const app = plane.apps[0]!;
    expect(app.expiresAt).toBeGreaterThan(Date.now());
    expect(plane.calls.find((c) => c.method === "POST" && c.path === "/tenants/t1/apps")!.body).toMatchObject({ ephemeral: { ttlSeconds: 600 } });
    expect(plane.calls.find((c) => c.path.endsWith("/uploads"))!.body).toMatchObject({ ephemeral: true });
    expect(plane.calls.find((c) => c.path.endsWith("/releases"))!.body).toMatchObject({ ephemeral: true });
    expect(await space.discard("todo-pvab12", "appgov", result.app)).toBe(true);
    expect(app.status).toBe("purged");
    expect(plane.calls.at(-1)).toMatchObject({ path: `/apps/${result.app}/actions`, manager: "appgov", body: { type: "discard" } });
  });

  test("the same files again release nothing; the files of an earlier release go back by the typed action rollback", async () => {
    const { plane, space } = setup();
    const dir = appDir();
    await space.publish("todo", dir, { manager: MANAGER });
    const first = { ...plane.apps[0]!.releases[0]! };
    expect((await space.publish("todo", dir, { manager: MANAGER })).output).toContain("already serves these exact files");
    expect(plane.apps[0]!.releases).toHaveLength(1);
    writeFileSync(join(dir, "app", "public", "style.css"), "body{color:red}\n");
    await space.publish("todo", dir, { manager: MANAGER });
    expect(plane.apps[0]!.current).toBe(2);
    cpSync(join(TEMPLATE, "app", "public", "style.css"), join(dir, "app", "public", "style.css"));
    const back = await space.publish("todo", dir, { manager: MANAGER });
    expect(back.output).toContain("went back to release 1");
    expect(plane.calls.filter((c) => c.path.endsWith("/uploads"))).toHaveLength(2);
    expect(plane.calls.at(-1)).toMatchObject({ body: { type: "rollback", release: 1 }, manager: "appgov" });
    expect(plane.apps[0]!.releases.at(-1)!.digest).toBe(first.digest);
  });

  test("a probe needs the app's own answer on both paths; the plane's refusal is not one", async () => {
    const { plane, space } = setup();
    await space.publish("todo", appDir(), { manager: MANAGER });
    expect(await space.probe("todo")).toMatchObject({ ok: true, status: 200 });
    plane.refuseApps = true;
    const refused = await space.probe("todo");
    expect(refused.ok).toBe(false);
    expect(refused.detail).toContain("not the app itself");
  });

  test("a probe puts a preview to sleep again, so a waiting change does not hold an awake slot; a discard waits for that", async () => {
    const { plane, space } = setup();
    const published = await space.publish("todo-pvab12", appDir(), { ephemeral: { ttlSeconds: 600 }, manager: MANAGER });
    await space.probe("todo-pvab12");
    expect(await space.discard("todo-pvab12", MANAGER.name, published.app)).toBe(true);
    const actions = plane.calls.filter((call) => call.path.endsWith("/actions")).map((call) => (call.body as { type: string }).type);
    expect(actions).toEqual(["sleep", "discard"]);
  });

  test("a lookup reads the detail by the id it found before, and looks the name up again when that id is gone", async () => {
    const { plane, space } = setup();
    await space.publish("todo", appDir(), { manager: MANAGER });
    const lists = () => plane.calls.filter((call) => call.method === "GET" && call.path.endsWith("/apps")).length;
    const before = lists();
    expect(await space.app("todo")).toMatchObject({ name: "todo" });
    expect(lists()).toBe(before);
    // The app is gone and another took its name: the remembered id no longer answers, so the name is listed again.
    plane.apps.splice(0, plane.apps.length);
    await space.publish("todo", appDir(), { manager: MANAGER });
    const again = await space.app("todo");
    expect(again).toMatchObject({ name: "todo" });
    expect(lists()).toBeGreaterThan(before);
  });

  test("the tenant's ephemeral quota and a ttl above the plane's maximum reach the Host's previews in the words they read", async () => {
    const { plane, space } = setup();
    const previews = (ttlSeconds: number) => new Previews({ space, manager: MANAGER, ttlSeconds, log: () => {} });
    plane.ephemeralQuota = 0;
    const quota = await previews(600).boot("todo-pv0001", appDir());
    expect(quota.ok).toBe(false);
    expect(!quota.ok && quota.refused).toContain("ephemeral apps are all in use");
    plane.ephemeralQuota = 3;
    plane.maxTtl = 300;
    const ttl = await previews(600).boot("todo-pv0002", appDir());
    expect(!ttl.ok && ttl.refused).toContain("300");
  });

  test("taking an app down removes it; tokens cannot purge, so the name stays taken and that is said", async () => {
    const { plane, space } = setup();
    await space.publish("todo", appDir(), { manager: MANAGER });
    expect(await space.takeDown("todo", "appgov")).toBe(false);
    expect(plane.apps[0]!.status).toBe("removed");
    expect(await space.takeDown("nothing", "appgov")).toBe(true);
  });

  test("an app managed by another manager is not this Host's to change", async () => {
    const { space } = setup();
    await space.publish("todo", appDir(), { manager: { name: "someone" } });
    const result = await space.publish("todo", appDir(), { manager: MANAGER });
    expect(result.code).toBe(1);
    expect(result.output).toContain("someone manages");
  });
});
