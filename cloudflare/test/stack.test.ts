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

interface Run {
  /** The owner's machine: APPGOV_HOME holds the owner credentials file and, once signed in, the session. */
  owner?: boolean;
  env?: Record<string, string>;
  script?: string;
}

const runEnv = ({ owner = false, env = {} }: Run) => ({ PATH: process.env.PATH ?? "", HOME: root, APPGOV_HOME: owner ? ownerHome : agentHome, APPGOV_AGENT: "test-agent", ...env });

// Asynchronous: the gateway and the container run in this process, so a synchronous spawn would starve them. No
// terminal, as a coding agent runs a command.
function cli(cwd: string, args: string[], run: Run = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [run.script ?? CLI, ...args], { cwd, env: runEnv(run), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("close", (code) => resolve({ code, out }));
  });
}

/** The CLI in an interactive terminal, as a person runs it: each prompt to type a word is answered with the next of `answers`. */
async function inTerminal(cwd: string, args: string[], run: Run & { answers?: string[] } = {}): Promise<{ code: number | null; out: string }> {
  const answers = run.answers ?? [];
  let out = "";
  let answered = 0;
  const child = Bun.spawn(["node", run.script ?? CLI, ...args], {
    cwd,
    env: runEnv(run),
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
  // What a person reads: without the terminal's control sequences and carriage returns.
  return { code, out: out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "") };
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
    // Signing in is a person's act: without a terminal it is refused, even with the owner credentials file at hand.
    const agentLogin = await cli(root, ["--host", stack.url, "login"], { owner: true });
    expect(agentLogin.code).toBe(2);
    expect(agentLogin.out).toContain("login is the owner's to do, by a person in a terminal");
    expect(existsSync(join(ownerHome, "hosts", "test", "session.json"))).toBe(false);
    const login = await inTerminal(root, ["--host", stack.url, "login"], { owner: true });
    expect(login.code).toBe(0);
    expect(login.out).toContain("signed in");
    // Signed in, creating a token still needs the terminal and the typed word.
    expect((await cli(root, ["--host", stack.url, "token", "create", "--label", "laptop", "--write", apps()], { owner: true })).code).toBe(2);
    expect(existsSync(join(apps(), ".appgov", "centre.json"))).toBe(false);
    const made = await inTerminal(root, ["--host", stack.url, "token", "create", "--label", "laptop", "--write", apps()], { owner: true, answers: ["create"] });
    expect(made.code).toBe(0);
    const centre = JSON.parse(readFileSync(join(apps(), ".appgov", "centre.json"), "utf8"));
    expect(centre.url).toBe(stack.url);
    expect(made.out).not.toContain(centre.token);
    expect(statSync(join(apps(), ".appgov", "centre.json")).mode & 0o777).toBe(0o600);
    // Without the owner's session, tokens are refused.
    expect((await cli(apps(), ["token", "list"])).code).toBe(2);
  });

  test("the token's directory explains itself: the centre's own CLI, and an AGENTS.md that says the token file is a credential", async () => {
    // The CLI written there is the one the centre serves, byte for byte.
    expect(readFileSync(join(apps(), ".appgov", "appgov.mjs"), "utf8")).toBe(readFileSync(CLI, "utf8"));
    const agents = readFileSync(join(apps(), "AGENTS.md"), "utf8");
    expect(agents).toContain(`The centre is at ${stack.url}.`);
    expect(agents).toContain("node .appgov/appgov.mjs create <name>");
    expect(agents).toContain("node .appgov/appgov.mjs fetch <name>");
    expect(agents).toContain("Never print it or show its contents, copy it into another file, or commit it");
    expect(readFileSync(join(apps(), "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
    // An agent there runs that CLI, and the empty list points at a file that is there.
    const listed = await cli(apps(), ["list"], { script: join(apps(), ".appgov", "appgov.mjs") });
    expect(listed.code).toBe(0);
    expect(listed.out).toContain("no apps yet. Create one with: node .appgov/appgov.mjs create <name>");
  });

  test("a CLI at another API level than the centre refuses, and update replaces it with the centre's own", async () => {
    const dir = join(root, "older-cli");
    mkdirSync(join(dir, ".appgov"), { recursive: true });
    const old = join(dir, ".appgov", "appgov.mjs");
    writeFileSync(old, readFileSync(CLI, "utf8").replace("const HOST_API_LEVEL = 1;", "const HOST_API_LEVEL = 0;"));
    writeFileSync(join(dir, ".appgov", "centre.json"), readFileSync(join(apps(), ".appgov", "centre.json")), { mode: 0o600 });
    const refused = await cli(dir, ["list"], { script: old });
    expect(refused.code).toBe(3);
    expect(refused.out).toContain("this CLI is written for API level 0, and the centre at");
    expect(refused.out).toContain("node .appgov/appgov.mjs update");
    const updated = await cli(dir, ["update"], { script: old });
    expect(updated.out).toContain("replaced .appgov/appgov.mjs with the centre's own CLI");
    expect(readFileSync(old, "utf8")).toBe(readFileSync(CLI, "utf8"));
    expect((await cli(dir, ["list"], { script: old })).code).toBe(0);
    // The repository's own CLI is never replaced.
    expect((await cli(dir, ["update"])).out).toContain("the owner reruns the installer");
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
    // Made with the agent token: the record names the agent and the token, not the Host on the owner's behalf.
    expect((await cli(copy(), ["history"])).out).toMatch(/create published -> v1 by test-agent \(agent token "laptop" \(t[a-f0-9]+\)\) \[agent-driven\]/);
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
    expect(submitted.out).toMatch(new RegExp(`signed in as the owner, in their own terminal, with: node \\S+ approve ${id}`));
    // An agent: no terminal, no session. Refused before anything is sent.
    const refused = await cli(copy(), ["approve", id]);
    expect(refused.code).toBe(2);
    expect(refused.out).toContain("is the owner's to do, by a person in a terminal; this command has none, so nothing was sent");
    // An agent on the owner's machine, where the owner's session file is: still refused, for want of a terminal.
    for (const args of [["approve", id], ["deny", id, "no"]]) {
      const onOwnersMachine = await cli(copy(), args, { owner: true });
      expect(onOwnersMachine.code).toBe(2);
      expect(onOwnersMachine.out).toContain("this command has none, so nothing was sent");
    }
    expect((await cli(copy(), ["status"])).out).toContain(`waiting for the owner: ${id}`);
    // The Worker refuses the agent token on its own.
    const token = JSON.parse(readFileSync(join(copy(), ".appgov", "centre.json"), "utf8")).token as string;
    const direct = await fetch(`${stack.url}/apps/todo/changes/${id}/approve`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
    expect(direct.status).toBe(403);
    // A word other than the one asked for changes nothing.
    const mistyped = await inTerminal(copy(), ["approve", id], { owner: true, answers: ["yes"] });
    expect(mistyped.out).toContain("not confirmed; nothing changed");
    expect((await cli(copy(), ["status"])).out).toContain(`waiting for the owner: ${id}`);
    const approved = await inTerminal(copy(), ["approve", id], { owner: true, env: { CODEX_THREAD_ID: "x" }, answers: ["approve"] });
    expect(approved.out).toContain('Type "approve" to confirm, as the owner:');
    expect(approved.out).toContain("published v3");
    expect(approved.code).toBe(0);
    expect(stack.plane.serving("todo")).not.toBeNull();
    // The approval is the owner's, recorded as theirs; the change's author stays beside it.
    const history = (await cli(copy(), ["history"])).out;
    expect(history).toContain("change needs_approval by test-agent (agent token");
    expect(history).toMatch(/decision published -> v3 by user:owner \(owner session\) \[owner\]: Let visitors in/);
    expect(history).toContain("    the change was made by test-agent");
  });

  test("undo goes back one version: the earlier files serve and history shows it; the owner's undo is the owner's", async () => {
    // Where there is no agent token, a write does not fall back to the owner's session: that takes --owner and a terminal.
    const noToken = await cli(root, ["--host", stack.url, "--app", "todo", "undo", "the owner wants sign-in back"], { owner: true });
    expect(noToken.code).toBe(3);
    expect(noToken.out).toContain("no agent token for the centre");
    expect((await cli(root, ["--host", stack.url, "--app", "todo", "undo", "--owner", "back"], { owner: true })).code).toBe(2);
    // Run by the owner from inside another agent's environment: the record names the owner, not that agent.
    const undone = await inTerminal(root, ["--host", stack.url, "--app", "todo", "undo", "--owner", "the owner wants sign-in back"], { owner: true, env: { CLAUDECODE: "1" }, answers: ["undo"] });
    expect(undone.code).toBe(0);
    expect(undone.out).toContain("now on v2");
    expect((await cli(copy(), ["fetch"])).code).toBe(0);
    expect((await cli(copy(), ["history"])).out).toMatch(/restore rolled_back -> v2 by owner \(owner session\) \[owner\]: the owner wants sign-in back/);
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
    expect((await cli(copy(), ["container", "stop"], { owner: true })).code).toBe(2);
    const stopped = await inTerminal(copy(), ["container", "stop"], { owner: true, answers: ["stop"] });
    expect(stopped.out).toContain("stopped the Host's container");
    // Status is read from the app's stored view: no container starts for it.
    const status = await cli(copy(), ["status", "--timing"]);
    expect(status.code).toBe(0);
    expect(status.out).toMatch(/read the stored view from R2 \(no container\) +\d+ ms/);
    expect(stack.starts()).toBe(before);
    writeFileSync(join(copy(), "app", "public", "style.css"), "body { background: #ffffff; }\n");
    const submitted = await cli(copy(), ["submit", "White background", "--timing"]);
    expect(submitted.code).toBe(0);
    expect(submitted.out).toMatch(/load the record from R2 into the container +\d+ ms/);
    expect(stack.starts()).toBe(before + 1);
    // The answer carries where the time went, and --timing prints it.
    for (const step of ["the Host's operation", "copy the working tree into a draft", "check the draft", "tests", "publish the preview", "publish the release", "upload the package", "wait until the preview answers", "release the upload", "wait until the release answers", "record the version", "discard the preview", "save the record to R2", "compute the app's view in the container and store it in R2"]) {
      expect(submitted.out).toContain(step);
    }
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
    // The edits in the copy are that change: status says so, and does not call them "not submitted".
    expect(status).toMatch(/changed here: app\/server\.mjs, pneuma-space\.json\. These edits are change \S+, which was submitted and waits for the owner\. Do not submit them again/);
    expect(status).not.toContain("not submitted");
    // Edited further, they are no longer that change, and status says that too.
    writeFileSync(join(copy(), "app", "server.mjs"), `${readFileSync(join(copy(), "app", "server.mjs"), "utf8")}// more\n`);
    expect((await cli(copy(), ["status"])).out).toContain("changed here, not submitted: app/server.mjs, pneuma-space.json (they are not the change waiting for the owner as it was submitted)");
    expect((await cli(copy(), ["discard"])).code).toBe(0);
  });

  test("list is answered from the summaries in R2", async () => {
    const listed = await cli(apps(), ["list"]);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain("1 app at the centre");
  });

  test("an undo past a version that ran new SQL says that data is still stored and the older code may not show it", async () => {
    const server = join(copy(), "app", "server.mjs");
    writeFileSync(server, `${readFileSync(server, "utf8")}\nexport const migration = "ALTER TABLE notes ADD COLUMN due TEXT";\n`);
    const submitted = await cli(copy(), ["submit", "Notes get a due date"]);
    expect(submitted.code).toBe(0);
    const version = /published (v\d+)/.exec(submitted.out)![1]!;
    const undone = await cli(copy(), ["undo", "no due dates after all"]);
    expect(undone.code).toBe(0);
    const before = /now on (v\d+)/.exec(undone.out)![1]!;
    expect(undone.out).toContain("Code only; stored data was not rolled back.");
    expect(undone.out).toContain(`Data written by the code of ${version} is still stored, and ${before}'s code may not show it: ${version} ran SQL that ${before} does not (ALTER TABLE notes ADD COLUMN due TEXT).`);
  });

  test("a change the agent declares one-way waits for the owner with the agent's words, and the agent token cannot approve it", async () => {
    // Key-value data swept in code the rules read as an ordinary edit.
    const server = join(copy(), "app", "server.mjs");
    writeFileSync(server, `${readFileSync(server, "utf8")}\nexport const sweep = (items) => items.map(({ due, ...rest }) => rest);\n`);
    const submitted = await cli(copy(), ["submit", "Remove due dates", "--one-way", "deletes the due date from every stored list"]);
    expect(submitted.code).toBe(2);
    expect(submitted.out).toContain("needs_approval");
    expect(submitted.out).toContain("risks: source_code_change");
    expect(submitted.out).toContain('  - The agent that made this change declared it one-way. What is lost, in its own words (its statement, not something the rules found): "deletes the due date from every stored list"');
    const id = /needs_approval (\S+):/.exec(submitted.out)![1]!;
    // Straight to the Worker with the agent's token: refused there, whatever the CLI does.
    const token = JSON.parse(readFileSync(join(copy(), ".appgov", "centre.json"), "utf8")).token as string;
    const approve = await fetch(`${stack.url}/apps/todo/changes/${id}/approve`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
    expect(approve.status).toBe(403);
    const status = (await cli(copy(), ["status"])).out;
    expect(status).toContain(`waiting for the owner: ${id} "Remove due dates" (source_code_change)`);
    expect(status).toContain('add --one-way "<what is lost>": the owner then decides it');
  });

  test("the owner approves the declared change in a terminal; going back past it is theirs to confirm, and undo repeats the agent's words", async () => {
    const id = /waiting for the owner: (\S+) "Remove due dates"/.exec((await cli(copy(), ["status"])).out)![1]!;
    const approved = await inTerminal(copy(), ["approve", id], { owner: true, answers: ["approve"] });
    expect(approved.out).toContain('The agent that made this change declared it one-way. What is lost, in its own words (its statement, not something the rules found): "deletes the due date from every stored list"');
    expect(approved.out).toContain('ONE-WAY: declared one-way when it was submitted: "deletes the due date from every stored list". Going back past this version needs the owner\'s confirmation.');
    const version = /published (v\d+)/.exec(approved.out)![1]!;
    expect((await cli(copy(), ["history"])).out).toMatch(new RegExp(`decision published -> ${version} by user:owner \\(owner session\\) \\[owner\\]: Remove due dates`));

    // The agent's undo is refused at the crossing; confirming it without a terminal is refused on the owner's machine too.
    const plain = await cli(copy(), ["undo", "bring the dates back"]);
    expect(plain.code).toBe(2);
    expect(plain.out).toContain(`  - ${version}: declared one-way when it was submitted: "deletes the due date from every stored list"`);
    expect(plain.out).toContain("they run in their own terminal: node");
    expect((await cli(copy(), ["undo", "--accept-one-way", "bring the dates back"], { owner: true })).code).toBe(2);
    expect((await cli(copy(), ["status"])).out).toContain(`todo: ${version}`);

    const undone = await inTerminal(copy(), ["undo", "--accept-one-way", "bring the dates back"], { owner: true, answers: ["undo", "accept"] });
    expect(undone.code).toBe(0);
    expect(undone.out).toContain(`${version} was declared one-way when it was submitted: "deletes the due date from every stored list". Going back put back its code, not what it did to stored data.`);
    expect((await cli(copy(), ["history"])).out).toMatch(/restore rolled_back -> v\d+ by owner \(owner session\) \[owner\]: bring the dates back/);
  });

  test("in a working copy, an undo without --owner goes with the agent token and is recorded as the agent's, even on the owner's machine", async () => {
    const server = join(copy(), "app", "server.mjs");
    writeFileSync(server, `${readFileSync(server, "utf8")}// one more line\n`);
    expect((await cli(copy(), ["submit", "One more line"])).code).toBe(0);
    expect((await cli(copy(), ["undo", "not that line"], { owner: true })).code).toBe(0);
    expect((await cli(copy(), ["history"])).out).toMatch(/restore rolled_back -> v\d+ by test-agent \(agent token "laptop" \(t[a-f0-9]+\)\) \[agent-driven\]: not that line/);
    // Submitting as the owner takes the terminal and the word as well.
    writeFileSync(server, `${readFileSync(server, "utf8")}// the owner's own line\n`);
    expect((await cli(copy(), ["submit", "--owner", "The owner's line"], { owner: true })).code).toBe(2);
    const own = await inTerminal(copy(), ["submit", "--owner", "The owner's line"], { owner: true, answers: ["submit"] });
    expect(own.out).toMatch(/published v\d+/);
    expect((await cli(copy(), ["history"])).out).toMatch(/change published -> v\d+ by owner \(owner session\) \[owner\]: The owner's line/);
  });

  test("status in a working copy that is behind says how far, and does not call that version's files edits", async () => {
    const second = join(root, "elsewhere", "todo");
    expect((await cli(second, ["fetch"])).code).toBe(0);
    const held = /todo: (v\d+)/.exec((await cli(second, ["status"])).out)![1]!;

    // The centre releases one version from the first copy.
    const style = join(copy(), "app", "public", "style.css");
    writeFileSync(style, `${readFileSync(style, "utf8")}\nh1 { letter-spacing: 0.01em; }\n`);
    const next = /published (v\d+)/.exec((await cli(copy(), ["submit", "Wider headings"])).out)![1]!;
    let status = (await cli(second, ["status"])).out;
    expect(status).toContain(`this working copy is behind the centre: it holds ${held}, and the centre is on ${next}. Since this copy was last brought up to date, the centre released ${next} (1 version behind). Run fetch before changing anything.`);
    expect(status).toContain(`changed here, not submitted: none (the files here are ${held}'s, the version this copy holds)`);
    const json = JSON.parse((await cli(second, ["status", "--json"])).out);
    expect(json).toMatchObject({ behind: { holds: held, centre: next, released: [next], went_back_past: [] }, uncommitted_here: [] });

    // The other way: this copy is brought up to date, and the centre goes back past what it holds.
    expect((await cli(second, ["fetch"])).code).toBe(0);
    expect((await cli(copy(), ["undo", "narrower headings after all"])).code).toBe(0);
    status = (await cli(second, ["status"])).out;
    expect(status).toContain(`this working copy is behind the centre: it holds ${next}, and the centre is on ${held}. Since this copy was last brought up to date, the centre went back past ${next}. Run fetch before changing anything.`);
    expect(status).toContain(`changed here, not submitted: none (the files here are ${next}'s, the version this copy holds)`);

    // Edits made here on the older version are listed as edits, against that version.
    writeFileSync(join(second, "app", "public", "app.js"), "// edited on the copy that is behind\n");
    status = (await cli(second, ["status"])).out;
    expect(status).toContain(`changed here, not submitted: app/public/app.js (edited here on ${next}, the version this copy holds, so fetch refuses while they are here`);
    expect((await cli(second, ["discard"])).code).toBe(0);
  });
});
