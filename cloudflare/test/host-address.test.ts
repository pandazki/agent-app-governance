import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HomeModel } from "../../local/src/page-model";
import { PAGE_COOKIE } from "../worker/page";
import { modelOf, startStack, type Stack } from "./stack";

// The Host on the owner's domain: the Worker answers at two addresses, as it does once the installer was given
// --domain. The domain is the Host's own address (`stack.url`), the one it gives everywhere; the workers.dev address
// (`stack.otherUrl`) keeps answering the API for working copies that hold it, and sends the page to the domain.

const CLI = join(import.meta.dir, "..", "bin", "appgov.mjs");
let stack: Stack;
let root: string;
let own: string;
let old: string;

const env = (owner: boolean) => ({ PATH: process.env.PATH ?? "", HOME: root, APPGOV_HOME: owner ? join(root, "owner-home") : join(root, "agent-home"), APPGOV_AGENT: "codex" });
function cli(cwd: string, args: string[], cliFile = CLI): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [cliFile, ...args], { cwd, env: env(false), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) => resolve({ code, out, err }));
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
const dir = () => join(root, "apps");
const centre = () => JSON.parse(readFileSync(join(dir(), ".appgov", "centre.json"), "utf8")) as { url: string; token: string };

beforeAll(async () => {
  stack = await startStack({ domain: true });
  own = stack.url;
  old = stack.otherUrl!;
  root = mkdtempSync(join(tmpdir(), "appgov-cf-address-"));
  mkdirSync(join(root, "owner-home", "hosts", "test"), { recursive: true });
  mkdirSync(join(root, "agent-home"), { recursive: true });
  mkdirSync(dir(), { recursive: true });
  // As the installer leaves it once the Host has the domain: the owner credentials at the Host's own address.
  writeFileSync(join(root, "owner-home", "hosts", "test", "owner.json"), JSON.stringify({ url: own, key: stack.ownerKey }), { mode: 0o600 });
  expect(await owner(root, ["--host", own, "login"])).toBe(0);
}, 120_000);

afterAll(async () => {
  await stack?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("the Host on the owner's domain", () => {
  test("a token is written with the Host's own address, whatever address the owner's command came by", async () => {
    expect(await owner(root, ["--host", own, "token", "create", "--label", "laptop", "--write", dir()], ["create"])).toBe(0);
    expect(centre().url).toBe(own);
    const starter = (await (await fetch(`${old}/starter`, { headers: { authorization: `Bearer ${centre().token}` } })).json()) as { host_url: string; agents: string };
    expect(starter.host_url).toBe(own);
    expect(starter.agents).toContain(own);
    expect(starter.agents).not.toContain(old);
  });

  test("a working copy that still holds the workers.dev address keeps working, is told once where the Host lives, and update moves it", async () => {
    // As the token's directory was before the domain: the same token, the old address.
    writeFileSync(join(dir(), ".appgov", "centre.json"), JSON.stringify({ ...centre(), url: old }), { mode: 0o600 });
    const made = await cli(dir(), ["create", "notes"]);
    expect(made.code).toBe(0);
    expect(made.err).toContain(`note: this centre's address is now ${own}; ${old} still answers.`);
    expect(made.err.split("note:").length).toBe(2);
    // A new working copy is written with the Host's own address, whatever address created it.
    const copyFile = join(dir(), "notes", ".appgov", "centre.json");
    const copy = () => JSON.parse(readFileSync(copyFile, "utf8")) as { url: string; token: string };
    expect(copy().url).toBe(own);
    // As one made before the domain.
    writeFileSync(copyFile, JSON.stringify({ ...copy(), url: old }), { mode: 0o600 });
    writeFileSync(join(dir(), "notes", "app", "public", "style.css"), "body { background: #fafaf7; }\n");
    const sent = await cli(join(dir(), "notes"), ["submit", "A warmer page"]);
    expect(sent.code).toBe(0);
    expect(sent.err).toMatch(/appgov\.mjs update moves \S*\/apps\/notes\/\.appgov\/centre\.json to it\.\n$/);

    // The CLI the token's directory has (written by token create) moves the nearest centre.json to the Host's address.
    const copyCli = join(dir(), ".appgov", "appgov.mjs");
    expect(existsSync(copyCli)).toBe(true);
    const moved = await cli(join(dir(), "notes"), ["update"], copyCli);
    expect(moved.code).toBe(0);
    expect(moved.out).toMatch(new RegExp(`^moved \\S*/apps/notes/\\.appgov/centre\\.json from ${old} to the centre's address, ${own}\\.$`, "m"));
    expect(copy().url).toBe(own);
    expect(copy().token).toBe(centre().token);
    const after = await cli(join(dir(), "notes"), ["status"]);
    expect([after.code, after.err]).toEqual([0, ""]);
    // And the token's directory, from there.
    expect(centre().url).toBe(old);
    expect((await cli(dir(), ["update"], copyCli)).code).toBe(0);
    expect(centre().url).toBe(own);
  });

  test("the API answers at both addresses and says on every answer where the Host lives", async () => {
    for (const at of [old, own]) {
      const res = await fetch(`${at}/apps`, { headers: { authorization: `Bearer ${centre().token}` } });
      expect([res.status, res.headers.get("x-appgov-host")]).toEqual([200, own]);
    }
  });

  test("apps are registered on PneumaSpace with the Host's own address as their manager, even when created by the other one", () => {
    const app = (stack.plane as unknown as { apps: { name: string; manager: { name: string; url: string | null } | null }[] }).apps.find((a) => a.name === "notes");
    expect(app?.manager).toEqual({ name: "appgov", url: `${own}/` });
  });

  test("the page lives at the Host's own address: by the other one a view is sent there and a write is refused", async () => {
    for (const path of ["/", "/app/notes?lang=zh", "/assets/app.css"]) {
      const res = await fetch(`${old}${path}`, { redirect: "manual" });
      expect([res.status, res.headers.get("location")]).toEqual([308, `${own}${path}`]);
    }
    const there = await fetch(`${old}/owner/signin`, { method: "POST", headers: { origin: old, "content-type": "application/json" }, body: JSON.stringify({ key: stack.ownerKey }) });
    expect([there.status, (await there.json()).reason]).toEqual([403, "not_from_this_page"]);
    expect(there.headers.get("set-cookie")).toBeNull();
    // A write sent to the domain from a page at the other address is another site's.
    const crossed = await fetch(`${own}/owner/signin`, { method: "POST", headers: { origin: old, "content-type": "application/json" }, body: JSON.stringify({ key: stack.ownerKey }) });
    expect(crossed.status).toBe(403);
    const signed = await fetch(`${own}/owner/signin`, { method: "POST", headers: { origin: own, "content-type": "application/json" }, body: JSON.stringify({ key: stack.ownerKey }) });
    expect(signed.status).toBe(200);
    const cookie = /__Host-appgov-page=([^;]+)/.exec(signed.headers.get("set-cookie") ?? "")![1]!;
    const home = await fetch(`${own}/?lang=en`, { headers: { cookie: `${PAGE_COOKIE}=${cookie}` } });
    const model = modelOf(await home.text()) as HomeModel;
    expect([home.status, model.view]).toEqual([200, "home"]);
    expect(JSON.stringify(model)).not.toContain(old);
  });
});
