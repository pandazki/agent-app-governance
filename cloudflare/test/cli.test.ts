import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRAMEWORK_DIR, STATE_DIR, TREE } from "../../host/src/artifact";
import { API_HEADER, API_LEVEL } from "../src/protocol";

// The CLI runs without the Host's code, so it carries copies of what it needs; these must agree with the Host.
const source = readFileSync(join(import.meta.dir, "..", "bin", "appgov.mjs"), "utf8");
const constant = (name: string) => new RegExp(`const ${name} = "([^"]+)";`).exec(source)?.[1];
const set = (name: string) => {
  const body = new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`).exec(source)?.[1] ?? "";
  return [...body.matchAll(/"([^"]+)"|(FRAMEWORK_DIR|STATE_DIR)/g)].map((m) => m[1] ?? (m[2] === "FRAMEWORK_DIR" ? FRAMEWORK_DIR : STATE_DIR)).sort();
};

describe("the Cloudflare edition's CLI", () => {
  test("names the Host's directories as the Host does", () => {
    expect(constant("STATE_DIR")).toBe(STATE_DIR);
    expect(constant("FRAMEWORK_DIR")).toBe(FRAMEWORK_DIR);
  });

  test("leaves out of a submitted tree exactly what the Host leaves out of a version", () => {
    expect(set("IGNORED_DIRS")).toEqual([...TREE.ignoredDirs!].sort());
    expect(set("IGNORED_FILES")).toEqual([...TREE.ignoredFiles!].sort());
    expect(set("IGNORED_PATHS")).toEqual([...TREE.ignoredPaths!].sort());
  });

  test("is written for the centre's API level, and reads the header the centre sends it in", () => {
    expect(Number(/const HOST_API_LEVEL = (\d+);/.exec(source)?.[1])).toBe(API_LEVEL);
    expect(constant("API_HEADER")).toBe(API_HEADER);
  });

  test("has no dependencies: only Node's own modules", () => {
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports.every((name) => name!.startsWith("node:"))).toBe(true);
  });

  test("never prints the agent token it writes", () => {
    expect(source).toContain("never prints it");
    expect(source).not.toMatch(/console\.log\([^)]*data\.token/);
  });
});

describe("what acts as the owner, without a terminal, on the owner's machine", () => {
  // An agent runs commands without an interactive terminal, as the same user as the owner: the owner's credentials file
  // and a live session are there for it to use. Every command that would act as the owner stops before sending anything.
  let home: string;
  let copy: string;
  let requests: string[];
  let server: ReturnType<typeof createServer>;
  let url: string;

  beforeAll(async () => {
    requests = [];
    server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url} ${req.headers.authorization ?? ""}`);
      res.writeHead(500, { [API_HEADER]: String(API_LEVEL) }).end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    home = mkdtempSync(join(tmpdir(), "appgov-cf-owner-"));
    mkdirSync(join(home, "hosts", "test"), { recursive: true });
    writeFileSync(join(home, "hosts", "test", "owner.json"), JSON.stringify({ url, key: `apk_${"0".repeat(64)}` }));
    writeFileSync(join(home, "hosts", "test", "session.json"), JSON.stringify({ url, session: `aps_${"1".repeat(64)}`, expires_at: new Date(Date.now() + 3600_000).toISOString() }));
    copy = join(home, "copy");
    mkdirSync(join(copy, ".appgov"), { recursive: true });
    writeFileSync(join(copy, ".appgov", "app.json"), JSON.stringify({ app_id: "todo" }));
    writeFileSync(join(copy, ".appgov", "centre.json"), JSON.stringify({ url, token: `apt_${"2".repeat(64)}` }));
  });
  afterAll(() => {
    server.close();
    rmSync(home, { recursive: true, force: true });
  });

  const run = (args: string[]) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn("node", [join(import.meta.dir, "..", "bin", "appgov.mjs"), ...args], { cwd: copy, env: { PATH: process.env.PATH ?? "", HOME: home, APPGOV_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (out += chunk));
      child.on("close", (code) => resolve({ code, out }));
    });

  for (const args of [
    ["approve", "c1"],
    ["deny", "c1", "no"],
    ["undo", "--accept-one-way", "back"],
    ["undo", "--owner", "back"],
    ["submit", "--owner", "a change"],
    ["discard", "--owner"],
    ["create", "--owner", "other"],
    ["token", "create", "--write", "elsewhere"],
    ["token", "revoke", "t1"],
    ["container", "stop"],
    ["login"],
  ]) {
    test(`${args.join(" ")} is refused, and nothing reaches the centre`, async () => {
      const before = requests.length;
      const result = await run(args);
      expect(result.code).toBe(2);
      expect(result.out).toContain("by a person in a terminal; this command has none, so nothing was sent");
      expect(result.out).toContain("If you are a coding agent: stop and show this to the user.");
      expect(requests.length).toBe(before);
    });
  }

  test("an undo without --owner goes with the agent token, not the owner's session", async () => {
    await run(["undo", "back"]);
    expect(requests.at(-1)).toBe(`POST /apps/todo/undo Bearer apt_${"2".repeat(64)}`);
  });
});
