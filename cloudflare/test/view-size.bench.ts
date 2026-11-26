// What an app's stored view costs as its history grows: time and bytes for the write that stores it and for each view
// the owner opens, at 10, 100 and 500 versions. The whole edition on one machine (test/stack.ts); R2 is a map here, so
// the times are the Worker's and the container's own work, and the bytes are what R2 would store and send.
//
// Each app is created and changed once through the CLI, then its folder is grown by hand to N versions of the same
// size as the real ones (a full copy of the app per version, one file changed each time, one history line per
// version as the Host writes it), saved back to the bucket as another writer would, and a change that waits is
// submitted: that submit is the write measured.
//
// usage: bun run test/view-size.bench.ts [N...]      (default: 10 100 500)
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { viewKey } from "../src/protocol";
import { PAGE_COOKIE } from "../worker/page";
import { growFolder } from "./grow";
import { startStack } from "./stack";

const sizes = process.argv.slice(2).map(Number).filter((n) => n >= 3);
const SIZES = sizes.length ? sizes : [10, 100, 500];
const CLI = join(import.meta.dir, "..", "bin", "appgov.mjs");
const RUNS = 3;

const stack = await startStack();
const root = mkdtempSync(join(tmpdir(), "appgov-view-size-"));
const ownerHome = join(root, "owner-home");
const apps = join(root, "apps");
mkdirSync(join(ownerHome, "hosts", "test"), { recursive: true });
mkdirSync(join(root, "agent-home"), { recursive: true });
mkdirSync(apps, { recursive: true });
writeFileSync(join(ownerHome, "hosts", "test", "owner.json"), JSON.stringify({ url: stack.url, key: stack.ownerKey }), { mode: 0o600 });
const env = (owner: boolean) => ({ PATH: process.env.PATH ?? "", HOME: root, APPGOV_HOME: owner ? ownerHome : join(root, "agent-home"), APPGOV_AGENT: "codex" });
const cli = (cwd: string, args: string[]) =>
  new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn("node", [CLI, ...args], { cwd, env: env(false), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ code, out }));
  });
const owner = (cwd: string, args: string[], answers: string[] = []) => {
  let out = "";
  let answered = 0;
  return Bun.spawn(["node", CLI, ...args], {
    cwd,
    env: env(true),
    terminal: {
      cols: 400,
      rows: 50,
      data(term, chunk) {
        out += new TextDecoder().decode(chunk);
        const asked = out.split('Type "').length - 1;
        while (answered < asked && answered < answers.length) term.write(`${answers[answered++]}\r`);
      },
    },
  }).exited;
};
const must = async (p: Promise<{ code: number | null; out: string }>, codes = [0]) => {
  const r = await p;
  if (!codes.includes(r.code ?? -1)) throw new Error(`CLI exited ${r.code}: ${r.out.slice(0, 600)}`);
  return r;
};

if ((await owner(root, ["--host", stack.url, "login"])) !== 0) throw new Error("login failed");
if ((await owner(root, ["--host", stack.url, "token", "create", "--label", "bench", "--write", apps], ["create"])) !== 0) throw new Error("token create failed");
const token = String(JSON.parse(readFileSync(join(apps, ".appgov", "centre.json"), "utf8")).token);
const signin = await fetch(`${stack.url}/owner/signin`, { method: "POST", headers: { origin: stack.url, "content-type": "application/json" }, body: JSON.stringify({ key: stack.ownerKey }) });
const cookie = /__Host-appgov-page=([^;]+)/.exec(signin.headers.get("set-cookie") ?? "")![1]!;

async function timed(path: string, headers: Record<string, string>): Promise<{ ms: number; bytes: number; status: number; source: string }> {
  const t0 = performance.now();
  const res = await fetch(`${stack.url}${path}`, { headers });
  const body = await res.arrayBuffer();
  const header = res.headers.get("server-timing") ?? "";
  const plan = /plan-source;desc="([^"]+)"/.exec(header)?.[1];
  const source = `${/(?:^|, )source;desc="([^"]+)"/.exec(header)?.[1] ?? "-"}${plan ? `, plan ${plan}` : ""}`;
  return { ms: Math.round(performance.now() - t0), bytes: body.byteLength, status: res.status, source };
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const kb = (bytes: number) => `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;

const rows: string[] = [];
for (const n of SIZES) {
  const app = `big${n}`;
  await must(cli(apps, ["create", app]));
  const copy = join(apps, app);
  writeFileSync(join(copy, "app", "public", "style.css"), "body { background: #fafaf7; }\n");
  await must(cli(copy, ["submit", "A warmer page"]));
  const tarBytes = await growFolder(stack, app, n);
  await must(cli(copy, ["fetch"]));
  writeFileSync(join(copy, "app", "server.mjs"), `${readFileSync(join(copy, "app", "server.mjs"), "utf8")}\n// A change that waits\n`);
  const t0 = performance.now();
  const sent = await must(cli(copy, ["submit", "A change that waits", "--one-way", "Nothing real", "--timing"]), [2]);
  const wall = Math.round(performance.now() - t0);
  const change = /needs_approval (\S+):/.exec(sent.out)?.[1];
  const step = (label: string) => Number(new RegExp(`${label}[^\\n]*?(\\d+) ms`).exec(sent.out)?.[1] ?? NaN);
  const centre = { save: step("save the record to R2"), view: step("store the app's summary and view in R2, both computed in the container") };
  const viewBytes = stack.bucket.objects.get(viewKey(app))?.bytes.length ?? 0;
  rows.push(`${n} versions | folder ${kb(tarBytes)} | write: submit ${wall} ms at the CLI, save ${centre.save} ms, view ${centre.view} ms, view stored ${kb(viewBytes)}`);
  console.log(rows.at(-1));

  const page = { cookie: `${PAGE_COOKIE}=${cookie}` };
  const api = { authorization: `Bearer ${token}` };
  const views: [string, string, Record<string, string>][] = [
    ["the list", "/", page],
    ["an app's page", `/app/${app}`, page],
    ["a waiting change", `/app/${app}/change/${change}`, page],
    ["going back one version", `/app/${app}/back/v${n - 1}`, page],
    ["going back to v2", `/app/${app}/back/v2`, page],
    ["CLI status", `/apps/${app}`, api],
    ["CLI history", `/apps/${app}/history`, api],
  ];
  for (const [label, path, headers] of views) {
    const first = await timed(path, headers);
    const again: number[] = [];
    let last = first;
    for (let i = 0; i < RUNS; i++) {
      last = await timed(path, headers);
      again.push(last.ms);
    }
    rows.push(`${n} versions | ${label} | ${first.status} | first ${first.ms} ms (${first.source}), then ${median(again)} ms (${last.source}) | ${kb(last.bytes)}`);
    console.log(rows.at(-1));
  }
}
await stack.close();
rmSync(root, { recursive: true, force: true });
console.log(`\n${rows.join("\n")}`);
