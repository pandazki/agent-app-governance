#!/usr/bin/env node
// Installs the Cloudflare edition's Host: one command, safe to run again.
//
//   node cloudflare/scripts/install.mjs <PneumaSpace origin> --space-owner <owner credentials file> --prefix <name>
//
// It checks everything it needs before it changes anything, then:
//   1. creates the R2 bucket <prefix>-folders near where the containers run (location hint wnam), unless it exists;
//   2. creates a PneumaSpace token with only the scopes the Host uses (read, publish, invoke, manage, remove), unless
//      the one it created before is still valid;
//   3. generates the owner key once, and keeps only its SHA-256 hash for the Worker;
//   4. builds the owner page (local/web/build.ts) and deploys the Worker <prefix> with it, its Durable Objects and the
//      Host's container, on workers.dev;
//   5. writes the owner credentials file, once, and checks that the owner can sign in.
// State, all of it private, lives in ~/.appgov/hosts/<prefix>/ (mode 0700). Nothing secret is printed, and Wrangler's
// output is shown with the account id taken out.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const EDITION = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(EDITION, "..");
const WRANGLER = join(EDITION, "node_modules", "wrangler", "bin", "wrangler.js");
const LOCAL = join(REPO, "local");
/** The owner page's built client, which the Worker serves as its static assets. */
const PAGE = join(LOCAL, "web", "dist");
const API = "https://api.cloudflare.com/client/v4";
const LOCATION = "wnam";
const SPACE_SCOPES = ["read", "publish", "invoke", "manage", "remove"];
const USAGE = "usage: node cloudflare/scripts/install.mjs <PneumaSpace origin> --space-owner <owner credentials file> --prefix <name> [--account <id>]";

class Stop extends Error {}
const log = (line) => console.log(`install: ${line}`);

function parse(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { "space-owner": { type: "string" }, prefix: { type: "string" }, account: { type: "string" } } });
  } catch (err) {
    throw new Stop(`${err.message}\n${USAGE}`);
  }
  const [origin] = parsed.positionals;
  const prefix = parsed.values.prefix;
  const owner = parsed.values["space-owner"];
  if (!origin || !prefix || !owner) throw new Stop(USAGE);
  let url;
  try {
    url = new URL(origin);
  } catch {}
  if (url?.protocol !== "https:") throw new Stop(`the PneumaSpace origin must be an https:// address, not "${origin}"`);
  if (!/^[a-z][a-z0-9-]{1,40}[a-z0-9]$/.test(prefix)) throw new Stop("--prefix takes 3 to 42 lowercase letters, digits and hyphens, starting with a letter");
  const stateDir = join(process.env.APPGOV_HOME?.trim() || join(homedir(), ".appgov"), "hosts", prefix);
  return { space: url.origin, spaceOwner: resolve(owner.replace(/^~(?=\/)/, homedir())), prefix, account: parsed.values.account, stateDir };
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

function writePrivate(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** Wrangler's output with the account id and anything that looks like a secret taken out. */
function redactor(secrets) {
  return (text) => {
    let out = text;
    for (const secret of secrets()) if (secret) out = out.split(secret).join("<redacted>");
    return out.replace(/\b[a-f0-9]{32}\b/g, "<id>");
  };
}

function wrangler(args, { capture = false, cwd, redact }) {
  if (capture) {
    const result = spawnSync(process.execPath, [WRANGLER, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: process.env });
    return { status: result.error ? 127 : (result.status ?? 1), stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }
  // Streamed, line by line, through the redactor; the whole output is kept for the error message.
  return new Promise((settle) => {
    const child = spawn(process.execPath, [WRANGLER, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let all = "";
    const show = (stream) => (chunk) => {
      const text = redact(chunk.toString());
      all += text;
      stream.write(text);
    };
    child.stdout.on("data", show(process.stdout));
    child.stderr.on("data", show(process.stderr));
    child.on("error", () => settle({ status: 127, output: all }));
    child.on("close", (status) => settle({ status: status ?? 1, output: all }));
  });
}

async function cfApi(session, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${session}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  }).catch((err) => {
    throw new Stop(`the Cloudflare API did not answer (${err.message}); run the same command again`);
  });
  const value = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok && value.success !== false, result: value.result, errors: (value.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ") };
}

/** PneumaSpace's API as its owner: a session from the owner credentials file, as PneumaSpace's own client signs in. */
async function spaceOwner(origin, file) {
  const credentials = readJson(file);
  if (!credentials?.account || !credentials?.key) throw new Stop(`${file} is not a PneumaSpace owner credentials file`);
  if (credentials.origin && new URL(credentials.origin).origin !== origin) throw new Stop(`${file} belongs to another PneumaSpace than ${origin}`);
  let cookie;
  let csrf;
  const call = async (path, body, method = body === undefined ? "GET" : "POST") => {
    const res = await fetch(`${origin}/api/v1${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
      headers: { origin, "content-type": "application/json", "idempotency-key": randomBytes(16).toString("hex"), ...(cookie ? { cookie, "x-pneuma-space-csrf": csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch((err) => {
      throw new Stop(`PneumaSpace at ${origin} did not answer (${err.message})`);
    });
    const value = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) throw new Stop(`PneumaSpace refused ${method} ${path}: ${value?.error?.code ?? res.status} ${value?.error?.message ?? ""}`.trim());
    return { value, res };
  };
  const login = await call("/auth/login", { account: credentials.account, key: credentials.key });
  cookie = login.res.headers.get("set-cookie")?.split(";")[0];
  csrf = login.value?.csrf;
  if (!cookie || !csrf) throw new Stop("PneumaSpace's sign-in returned no session");
  const tenant = login.value.tenants?.[0];
  if (!tenant?.id) throw new Stop("the PneumaSpace owner belongs to no tenant");
  return { tenant, api: async (path, body, method) => (await call(path, body, method)).value, close: () => call("/auth/logout", {}).catch(() => {}) };
}

function frameworkCommit() {
  const compose = readFileSync(join(REPO, "local", "compose.yaml"), "utf8");
  const line = compose.split("\n").find((l) => l.startsWith("x-framework-context:")) ?? "";
  const commit = /#([0-9a-f]{40})/.exec(line)?.[1];
  if (!commit) throw new Stop("could not read the pneuma-framework commit from local/compose.yaml (x-framework-context)");
  return commit;
}

/** The deployed Worker's configuration: the template with this install's names and absolute paths. */
function workerConfig(options, accountId, commit) {
  const template = JSON.parse(readFileSync(join(EDITION, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  return {
    ...template,
    $schema: undefined,
    name: options.prefix,
    account_id: accountId,
    main: join(EDITION, "worker", "index.ts"),
    assets: { ...template.assets, directory: PAGE },
    vars: { ...template.vars, APPGOV_SPACE_ORIGIN: options.space, APPGOV_LOCATION_HINT: LOCATION },
    r2_buckets: [{ binding: "FOLDERS", bucket_name: `${options.prefix}-folders` }],
    containers: template.containers.map((c) => ({
      ...c,
      name: options.prefix,
      images: { host: { dockerfile: join(EDITION, "container", "Dockerfile"), build_context: REPO, build_vars: { FRAMEWORK_COMMIT: commit } } },
    })),
  };
}

/** The owner page's client, built from the local edition's sources with its pinned tools (Bun, React, Tailwind, the fonts). */
function buildPage() {
  if (spawnSync("bun", ["--version"], { stdio: "ignore" }).status !== 0) throw new Stop("Bun is needed to build the owner page (https://bun.sh); install it, then run this again");
  if (!existsSync(join(LOCAL, "node_modules", "react", "package.json"))) {
    log("installing the owner page's build tools (local/scripts/setup.sh)");
    if (spawnSync("sh", ["scripts/setup.sh"], { cwd: LOCAL, stdio: "inherit" }).status !== 0) throw new Stop("local/scripts/setup.sh failed; fix what it reports and run this again");
  }
  log("building the owner page (local/web/build.ts)");
  if (spawnSync("bun", ["run", "web/build.ts"], { cwd: LOCAL, stdio: "inherit" }).status !== 0) throw new Stop("building the owner page failed; the output is above");
  for (const file of ["app.js", "app.css"]) if (!existsSync(join(PAGE, file))) throw new Stop(`the owner page's build left no ${file} in ${PAGE}`);
}

const ACCOUNT_TROUBLE = /plan|paid|subscription|entitle|permission|not authori[sz]ed|forbidden|quota|limit exceeded|not enabled|billing/i;

export async function install(options) {
  // --- checks, before anything changes -------------------------------------------------------------------
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) throw new Stop(`Node.js 20 or later is needed; this is ${process.version}`);
  if (!existsSync(WRANGLER)) {
    log("installing this edition's tools (npm ci in cloudflare/)");
    if (spawnSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: EDITION, stdio: "inherit" }).status !== 0) throw new Stop("npm ci in cloudflare/ failed; fix what it reports and run this again");
  }
  if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) throw new Stop("Docker does not answer; start it (the Host's image is built locally for linux/amd64). Set DOCKER_CONTEXT if it runs under another context");
  if (!existsSync(options.spaceOwner)) throw new Stop(`no PneumaSpace owner credentials file at ${options.spaceOwner}`);
  // Built here, on this machine, before anything on Cloudflare or PneumaSpace changes.
  buildPage();
  const commit = frameworkCommit();
  mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(options.stateDir, 0o700);
  const paths = {
    config: join(options.stateDir, "wrangler.json"),
    secrets: join(options.stateDir, "worker-secrets.json"),
    install: join(options.stateDir, "install.json"),
    owner: join(options.stateDir, "owner.json"),
    ownerKey: join(options.stateDir, "owner-key.json"),
  };
  const kept = readJson(paths.secrets) ?? {};
  const record = readJson(paths.install) ?? {};
  let accountId = "";
  const secretValues = () => [accountId, kept.APPGOV_SPACE_TOKEN, kept.APPGOV_CONTAINER_SECRET, kept.APPGOV_OWNER_KEY_HASH];
  const redact = redactor(secretValues);

  const who = wrangler(["whoami", "--json"], { capture: true, cwd: options.stateDir });
  let identity = {};
  try {
    identity = JSON.parse(who.stdout);
  } catch {}
  if (who.status !== 0 || !identity.loggedIn) throw new Stop("Wrangler is not logged in to Cloudflare: run `npx wrangler login` in cloudflare/, then run this again");
  const accounts = identity.accounts ?? [];
  const account = options.account ? accounts.find((a) => a.id === options.account) : accounts.length === 1 ? accounts[0] : undefined;
  if (!account) throw new Stop(options.account ? "the Wrangler login cannot see that account" : `the Wrangler login sees ${accounts.length} accounts; name one with --account <id>`);
  accountId = account.id;
  const auth = wrangler(["auth", "token", "--json"], { capture: true, cwd: options.stateDir });
  let session;
  try {
    session = JSON.parse(auth.stdout).token;
  } catch {}
  if (auth.status !== 0 || !session) throw new Stop("Wrangler returned no session token; run `npx wrangler login` again");

  const scripts = await cfApi(session, "GET", `/accounts/${accountId}/workers/scripts`);
  if (!scripts.ok) throw new Stop(`listing the account's Workers failed (${scripts.status}: ${scripts.errors})`);
  if (scripts.result.some((s) => s.id === options.prefix) && record.worker !== options.prefix) {
    throw new Stop(`the account already has a Worker named ${options.prefix}, and this machine did not install it; pick another --prefix`);
  }
  const sub = await cfApi(session, "GET", `/accounts/${accountId}/workers/subdomain`);
  if (!sub.ok || !sub.result?.subdomain) throw new Stop(`the account has no workers.dev subdomain yet (${sub.errors || sub.status}); open Workers in the Cloudflare dashboard once to choose one, then run this again`);
  const url = `https://${options.prefix}.${sub.result.subdomain}.workers.dev`;

  const space = await spaceOwner(options.space, options.spaceOwner);
  try {
    const ephemeral = space.tenant.quota?.ephemeral;
    if (ephemeral !== undefined && ephemeral < 1) throw new Stop("the PneumaSpace tenant allows no ephemeral apps, which the Host needs for previews");
    log(`checked: Node ${process.version}, Docker, the owner page built, Wrangler logged in, PneumaSpace ${options.space} signs in its owner, pneuma-framework ${commit.slice(0, 7)}`);

    // --- 1. the bucket ---------------------------------------------------------------------------------------
    const bucket = `${options.prefix}-folders`;
    const buckets = wrangler(["r2", "bucket", "list"], { capture: true, cwd: options.stateDir });
    if (buckets.status !== 0) throw new Stop(`listing R2 buckets failed: ${redact(buckets.stderr || buckets.stdout).slice(0, 600)}`);
    if (new RegExp(`^name:\\s+${bucket}$`, "m").test(buckets.stdout)) log(`R2 bucket ${bucket} exists`);
    else {
      log(`creating R2 bucket ${bucket} (location ${LOCATION})`);
      const made = await wrangler(["r2", "bucket", "create", bucket, "--location", LOCATION], { cwd: options.stateDir, redact });
      if (made.status !== 0) throw new Stop(`creating the R2 bucket failed; the output is above`);
    }

    // --- 2. the PneumaSpace token ----------------------------------------------------------------------------
    const tokens = (await space.api(`/tenants/${space.tenant.id}/tokens`)).items ?? [];
    const mine = record.space_token_id ? tokens.find((t) => t.id === record.space_token_id) : undefined;
    const valid = mine && !mine.revokedAt && mine.expiresAt > Date.now() + 7 * 86_400_000 && kept.APPGOV_SPACE_TOKEN;
    if (valid) log(`the PneumaSpace token ${mine.label} is still valid`);
    else {
      const made = await space.api(`/tenants/${space.tenant.id}/tokens`, { label: `${options.prefix} host`, scopes: SPACE_SCOPES, expiresAt: Date.now() + 364 * 86_400_000 });
      if (mine && !mine.revokedAt) await space.api(`/tenants/${space.tenant.id}/tokens/${mine.id}`, undefined, "DELETE");
      kept.APPGOV_SPACE_TOKEN = made.token;
      record.space_token_id = made.id;
      log(`created a PneumaSpace token for the Host with the scopes ${SPACE_SCOPES.join(", ")}`);
    }

    // --- 3. the owner key and the container secret -------------------------------------------------------------
    let ownerKey = readJson(paths.ownerKey)?.key;
    if (!ownerKey) {
      ownerKey = `apk_${randomBytes(32).toString("hex")}`;
      writePrivate(paths.ownerKey, { key: ownerKey });
    }
    kept.APPGOV_OWNER_KEY_HASH = sha256(ownerKey);
    kept.APPGOV_CONTAINER_SECRET ||= randomBytes(32).toString("hex");
    writePrivate(paths.secrets, kept);
    record.worker = options.prefix;
    record.url = url;
    record.bucket = bucket;
    record.space = options.space;
    writePrivate(paths.install, record);

    // --- 4. the Worker and its container ------------------------------------------------------------------------
    writePrivate(paths.config, workerConfig(options, accountId, commit));
    let deployed = false;
    for (let attempt = 1; attempt <= 3 && !deployed; attempt++) {
      if (attempt > 1) log(`deploy attempt ${attempt - 1} failed; trying again`);
      const run = await wrangler(["deploy", "--config", paths.config, "--secrets-file", paths.secrets], { cwd: options.stateDir, redact });
      deployed = run.status === 0;
      if (!deployed && ACCOUNT_TROUBLE.test(run.output)) throw new Stop("the deploy failed for a reason that looks like the account's (plan, permission or quota); the exact error is above. Nothing was retried");
    }
    if (!deployed) throw new Stop("the deploy failed three times; the output is above. Run the same command again once the cause is fixed");
  } finally {
    await space.close();
  }

  // --- 5. the owner's credentials, and a check that they sign in ---------------------------------------------------
  let answered = false;
  for (const deadline = Date.now() + 120_000; Date.now() < deadline && !answered; ) {
    try {
      const res = await fetch(`${url}/me`, { signal: AbortSignal.timeout(10_000) });
      answered = res.status === 401;
    } catch {}
    if (!answered) await new Promise((r) => setTimeout(r, 3000));
  }
  if (!answered) throw new Stop(`${url} does not answer yet; run the same command again in a minute`);
  const ownerKey = readJson(paths.ownerKey).key;
  const login = await fetch(`${url}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: ownerKey }), signal: AbortSignal.timeout(30_000) });
  if (login.status !== 200) throw new Stop(`the owner key does not sign in at ${url} (${login.status})`);
  const signedIn = (await login.json()).session;
  await fetch(`${url}/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${signedIn}` } }).catch(() => {});
  if (!existsSync(paths.owner)) writePrivate(paths.owner, { url, key: ownerKey });
  log(`installed. The Host answers at ${url}; its owner page is ${url}/ (sign in with the key in the owner credentials file)`);
  log(`owner credentials: ${paths.owner} (keep this file private; the CLI's login reads it)`);
  log(`next: node cloudflare/bin/appgov.mjs --host ${url} login, then token create --write <the directory your agent works in>`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await install(parse(process.argv.slice(2)));
  } catch (err) {
    if (!(err instanceof Stop)) throw err;
    console.error(`install: ${err.message}`);
    process.exitCode = 1;
  }
}
