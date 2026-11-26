import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEMPLATE } from "../src/edition";

// The template's jobs (app/space.mjs and app/jobs/), on its real server. PneumaSpace's part is played here: its broker
// keeps kv in a map, and a delivery is the request its plane sends (cf/src/app.ts, deliver, in PneumaSpace).

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const undo of cleanup.splice(0).reverse()) undo();
});

/** A copy of the template whose manifest declares `declared` as daily jobs and whose app/jobs/ holds `files`. */
function appWith(declared: readonly string[], files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "cf-template-jobs-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(TEMPLATE, dir, { recursive: true });
  const manifestFile = join(dir, "pneuma-space.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  if (declared.length) manifest.capabilities.cron = { triggers: Object.fromEntries(declared.map((name) => [name, { schedule: "0 3 * * *" }])) };
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  mkdirSync(join(dir, "app", "jobs"));
  for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, "app", "jobs", `${name}.mjs`), source);
  return dir;
}

const listen = (server: Server) => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));

/** The app's server as the runner starts it, with the broker it names in PNEUMA_SPACE_BROKER. */
async function running(dir: string) {
  const kv = new Map<string, { value: unknown; ttl?: number }>();
  const broker = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const command = JSON.parse(text);
    const reply = (value: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (command.type === "kv.get") {
      const item = kv.get(command.key);
      return reply(item ? { key: command.key, value: item.value, revision: 1, expiresAt: null } : null);
    }
    if (command.type === "kv.put") {
      kv.set(command.key, { value: command.value, ttl: command.ttl });
      return reply({ value: command.value, revision: 1 });
    }
    if (command.type === "kv.increment") {
      const value = Number(kv.get(command.key)?.value ?? 0) + command.amount;
      kv.set(command.key, { value });
      return reply({ value, revision: 1 });
    }
    res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "command", message: "Unsupported command." } }));
  });
  const brokerPort = await listen(broker);
  const probe = createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  const output: string[] = [];
  const child = spawn("node", ["server.mjs"], { cwd: join(dir, "app"), env: { PATH: process.env.PATH ?? "", PNEUMA_SPACE_PORT: String(port), PNEUMA_SPACE_BROKER: `http://127.0.0.1:${brokerPort}` } });
  for (const [stream, level] of [[child.stdout, "info"], [child.stderr, "error"]] as const) {
    stream.on("data", (chunk: Buffer) => output.push(...String(chunk).split("\n").filter(Boolean).map((line) => `${level} ${line}`)));
  }
  cleanup.push(() => {
    child.kill();
    broker.close();
  });
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${origin}/api/items`).then(() => true, () => false)) break;
    await Bun.sleep(50);
  }
  const deliver = (name: string, id: string, payload: unknown = null, attempt = 1) =>
    fetch(`${origin}/_pneuma-space/trigger/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pneuma-space-delivery": id, "x-pneuma-space-delivery-attempt": String(attempt) },
      body: JSON.stringify(payload),
    });
  return { origin, kv, output, deliver };
}

const tally = "import {native} from '../space.mjs';\nexport default async function ({payload}) { await native({type: 'kv.increment', key: 'tally', amount: payload?.by ?? 1}); }\n";

describe("scheduled jobs in the Cloudflare template", () => {
  test("a delivery runs the job of its name with its payload once; the same delivery again answers 200 and runs nothing", async () => {
    const app = await running(appWith(["tally"], { tally }));
    expect((await app.deliver("tally", "d1", { by: 2 })).status).toBe(200);
    expect((await app.deliver("tally", "d1", { by: 2 }, 2)).status).toBe(200);
    expect((await app.deliver("tally", "d2")).status).toBe(200);
    expect(app.kv.get("tally")?.value).toBe(3);
    expect(app.kv.get("job:done:d1")?.ttl).toBe(86400);
    expect(app.output).toContain("info job tally skipped delivery d1: it already finished");
    expect(app.output).toContain("info job tally finished delivery d2 (attempt 1)");
  });

  test("a job that throws answers 500 and logs its name, delivery and error; the next attempt runs it again", async () => {
    const flaky = "import {native} from '../space.mjs';\nexport default async function () { const n = await native({type: 'kv.increment', key: 'tries', amount: 1}); if (n.value < 2) throw new Error('not yet'); }\n";
    const app = await running(appWith(["flaky"], { flaky }));
    expect((await app.deliver("flaky", "d3")).status).toBe(500);
    expect(app.output).toContain("error job flaky failed delivery d3 (attempt 1): not yet");
    expect(app.kv.has("job:done:d3")).toBe(false);
    expect((await app.deliver("flaky", "d3", null, 2)).status).toBe(200);
    expect(app.kv.get("tries")?.value).toBe(2);
    expect(app.kv.has("job:done:d3")).toBe(true);
  });

  test("the data API still answers beside the job route, through the same native()", async () => {
    const app = await running(appWith(["tally"], { tally }));
    const response = await fetch(`${app.origin}/api/items`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { items: unknown[]; sample: boolean }).sample).toBe(true);
  });

  test("the template's own tests refuse a declared job without its file, and a file in app/jobs/ without its declaration", () => {
    const npmTest = (dir: string) => {
      const run = spawnSync("npm", ["test"], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
      return { code: run.status, out: run.stdout + run.stderr };
    };
    const missing = npmTest(appWith(["digest"], {}));
    expect(missing.code).not.toBe(0);
    expect(missing.out).toContain("pneuma-space.json declares the job digest, but app/jobs/digest.mjs is missing.");
    const undeclared = npmTest(appWith([], { digest: tally }));
    expect(undeclared.code).not.toBe(0);
    expect(undeclared.out).toContain("app/jobs/digest.mjs is not declared.");
    expect(npmTest(appWith(["digest"], { digest: tally })).code).toBe(0);
  });
});
