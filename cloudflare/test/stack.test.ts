import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { folderKey } from "../src/protocol";
import { startStack, type Stack } from "./stack";

// The CLI against the whole edition on this machine (test/stack.ts): the done list of the Cloudflare edition,
// offline. The real deployment runs the same steps; this catches what can be caught without it.

const CLI = join(import.meta.dir, "..", "bin", "appgov.mjs");
let stack: Stack;
let root: string;
let ownerHome: string;
let agentHome: string;

// Asynchronous: the gateway and the container run in this process, so a synchronous spawn would starve them.
function cli(cwd: string, args: string[], { owner = false, env = {} }: { owner?: boolean; env?: Record<string, string> } = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI, ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? "", HOME: root, APPGOV_HOME: owner ? ownerHome : agentHome, APPGOV_AGENT: "test-agent", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const apps = () => join(root, "apps");
const copy = () => join(apps(), "todo");

beforeAll(async () => {
  stack = await startStack();
  root = mkdtempSync(join(tmpdir(), "appgov-cf-stack-"));
  ownerHome = join(root, "owner-home");
  agentHome = join(root, "agent-home");
  mkdirSync(join(ownerHome, "hosts", "test"), { recursive: true });
  mkdirSync(agentHome, { recursive: true });
  mkdirSync(apps(), { recursive: true });
  writeFileSync(join(ownerHome, "hosts", "test", "owner.json"), JSON.stringify({ url: stack.url, key: stack.ownerKey }), { mode: 0o600 });
});

afterAll(async () => {
  await stack.close();
  rmSync(root, { recursive: true, force: true });
});

describe("the Cloudflare edition end to end, offline", () => {
  test("the owner signs in and writes an agent token for the agent's directory; the token is never printed", async () => {
    const login = await cli(root, ["--host", stack.url, "login"], { owner: true });
    expect(login.code).toBe(0);
    expect(login.out).toContain("signed in");
    const made = await cli(root, ["--host", stack.url, "token", "create", "--label", "laptop", "--write", apps()], { owner: true });
    expect(made.code).toBe(0);
    const centre = JSON.parse(readFileSync(join(apps(), ".appgov", "centre.json"), "utf8"));
    expect(centre.url).toBe(stack.url);
    expect(made.out).not.toContain(centre.token);
    expect(statSync(join(apps(), ".appgov", "centre.json")).mode & 0o777).toBe(0o600);
    // Without the owner's session, tokens are refused.
    expect((await cli(apps(), ["token", "list"])).code).toBe(2);
  });

  test("create, with the agent token: a managed app on the plane, and a working copy with the agent instructions", async () => {
    const made = await cli(apps(), ["create", "todo"]);
    expect(made.out).toContain("published v1");
    expect(made.code).toBe(0);
    const app = stack.plane.apps.find((a) => a.name === "todo" && a.expiresAt === null)!;
    expect(app.manager?.name).toBe("appgov");
    expect(readFileSync(join(copy(), "AGENTS.md"), "utf8")).toContain("## Changing this app (read this before the first edit)");
    expect(existsSync(join(copy(), ".appgov", "appgov.mjs"))).toBe(true);
    expect(existsSync(join(copy(), ".pneuma-framework", "versions", "v1"))).toBe(true);
    expect(JSON.parse(readFileSync(join(copy(), ".appgov", "centre.json"), "utf8")).url).toBe(stack.url);
    // The preview was an ephemeral app, and it was discarded.
    expect(stack.plane.apps.some((a) => a.expiresAt !== null && a.status === "purged")).toBe(true);
    expect(stack.bucket.objects.has(folderKey("todo"))).toBe(true);
  });

  test("an ordinary change is checked, previewed, approved by the standing rule and released; the working copy matches", async () => {
    writeFileSync(join(copy(), "app", "public", "style.css"), "body { background: #fafafa; }\n");
    const submitted = await cli(copy(), ["submit", "Lighter background"]);
    expect(submitted.out).toContain("published v2");
    expect(submitted.code).toBe(0);
    expect(stack.plane.serving("todo")!["public/style.css"]).toContain("#fafafa");
    const status = await cli(copy(), ["status"]);
    expect(status.out).toContain("todo: v2");
    expect(status.out).toContain("changed here, not submitted: none");
    const history = await cli(copy(), ["history"]);
    expect(history.out).toMatch(/change published -> v2 by test-agent/);
    expect(history.out).toContain("guarantees: verified, previewed");
    expect(existsSync(join(copy(), ".pneuma-framework", "versions", "v2"))).toBe(true);
  });

  test("a risky change waits for the owner; the agent token cannot approve it; the owner can", async () => {
    const manifest = JSON.parse(readFileSync(join(copy(), "pneuma-space.json"), "utf8"));
    manifest.capabilities.identity = {};
    writeFileSync(join(copy(), "pneuma-space.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const submitted = await cli(copy(), ["submit", "Let visitors in without the app knowing who they are"]);
    expect(submitted.code).toBe(2);
    expect(submitted.out).toContain("needs_approval");
    const id = /needs_approval (\S+):/.exec(submitted.out)![1]!;
    const refused = await cli(copy(), ["approve", id]);
    expect(refused.code).toBe(2);
    expect(refused.out).toContain("an agent token cannot do it");
    const approved = await cli(copy(), ["approve", id], { owner: true });
    expect(approved.out).toContain("published v3");
    expect(approved.code).toBe(0);
    expect(stack.plane.serving("todo")).not.toBeNull();
  });

  test("undo goes back one version: the earlier files serve and history shows it", async () => {
    const undone = await cli(copy(), ["undo", "the owner wants sign-in back"]);
    expect(undone.code).toBe(0);
    expect(undone.out).toContain("now on v2");
    expect(JSON.parse(readFileSync(join(copy(), "pneuma-space.json"), "utf8")).capabilities.identity).toEqual({ required: true });
    expect((await cli(copy(), ["history"])).out).toMatch(/restore rolled_back -> v2/);
  });

  test("a second, empty directory fetches with the token, changes and submits; the first copy is then behind", async () => {
    const token = JSON.parse(readFileSync(join(apps(), ".appgov", "centre.json"), "utf8")).token as string;
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    const fetched = await cli(elsewhere, ["fetch", "todo"], { env: { APPGOV_HOST: stack.url, APPGOV_TOKEN: token } });
    expect(fetched.code).toBe(0);
    const second = join(elsewhere, "todo");
    writeFileSync(join(second, "app", "public", "style.css"), "body { background: #f0f0f0; }\n");
    const submitted = await cli(second, ["submit", "A grey background"]);
    expect(submitted.out).toMatch(/published v\d+/);
    expect(stack.plane.serving("todo")!["public/style.css"]).toContain("#f0f0f0");

    writeFileSync(join(copy(), "app", "public", "app.js"), "// stale edit\n");
    const behind = await cli(copy(), ["submit", "From an old copy"]);
    expect(behind.code).toBe(3);
    expect(behind.out).toContain("working copy is on v2");
    expect((await cli(copy(), ["fetch"])).out).toContain("edits fetch would overwrite");
    expect((await cli(copy(), ["discard"])).code).toBe(0);
    const fetchedAgain = await cli(copy(), ["fetch"]);
    expect(fetchedAgain.code).toBe(0);
    expect(readFileSync(join(copy(), "app", "public", "style.css"), "utf8")).toContain("#f0f0f0");
  });

  test("a container that is gone takes nothing with it: the next operation works from R2 alone", async () => {
    const before = stack.starts();
    const stopped = await cli(copy(), ["container", "stop"], { owner: true });
    expect(stopped.out).toContain("stopped the Host's container");
    const status = await cli(copy(), ["status", "--timing"]);
    expect(status.code).toBe(0);
    expect(status.out).toMatch(/load=\d+/);
    expect(stack.starts()).toBe(before + 1);
    writeFileSync(join(copy(), "app", "public", "style.css"), "body { background: #ffffff; }\n");
    expect((await cli(copy(), ["submit", "White background"])).code).toBe(0);
  });

  test("a write to the record by someone else meanwhile is not overwritten; the next operation starts from what R2 holds", async () => {
    const key = folderKey("todo");
    const other = stack.bucket.objects.get(key)!.bytes;
    stack.bucket.interloper = () => stack.bucket.write(key, other);
    writeFileSync(join(copy(), "app", "public", "style.css"), "body { background: #eeeeee; }\n");
    const submitted = await cli(copy(), ["submit", "Another background"]);
    expect(submitted.code).toBe(3);
    expect(submitted.out).toContain("changed in R2 while this operation ran");
    expect(stack.bucket.objects.get(key)!.bytes).toBe(other);
    expect((await cli(copy(), ["status"])).code).toBe(0);
  });

  test("a change to app code that none of the app's own tests covered is released with the warning, and history says no tests ran", async () => {
    const tests = join(copy(), "tests", "server.test.mjs");
    writeFileSync(tests, readFileSync(tests, "utf8").replaceAll("test('", "test.skip('"));
    writeFileSync(join(copy(), "app", "server.mjs"), `${readFileSync(join(copy(), "app", "server.mjs"), "utf8")}\n// untested edit\n`);
    const submitted = await cli(copy(), ["submit", "An untested server edit"]);
    expect(submitted.code).toBe(0);
    expect(submitted.out).toMatch(/warning: this change touched app code \([^)]*app\/server\.mjs\) and none of the app's own tests ran, although tests\/ has test files \(tests\/server\.test\.mjs\)/);
    const history = (await cli(copy(), ["history"])).out;
    expect(history).toContain("No tests ran. 2 more tests were skipped or todo. tests/ has test files that did not run: tests/server.test.mjs.");
    expect(history).toContain("all of them the app's own.");
    expect(history).not.toContain("sdk/");
  });

  test("a waiting change shows in status what its tests covered", async () => {
    const manifest = JSON.parse(readFileSync(join(copy(), "pneuma-space.json"), "utf8"));
    manifest.capabilities.identity = {};
    writeFileSync(join(copy(), "pneuma-space.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(copy(), "app", "server.mjs"), `${readFileSync(join(copy(), "app", "server.mjs"), "utf8")}// another\n`);
    expect((await cli(copy(), ["submit", "Drop sign-in again"])).code).toBe(2);
    const status = (await cli(copy(), ["status"])).out;
    expect(status).toContain("  tests: No tests ran.");
    expect(status).toContain("  warning: this change touched app code (app/server.mjs)");
    expect((await cli(copy(), ["discard"])).code).toBe(0);
  });

  test("list is answered from the summaries in R2", async () => {
    const listed = await cli(apps(), ["list"]);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain("1 app at the centre");
  });
});
