#!/usr/bin/env node
// The artifact's own CLI, for the Cloudflare edition. No dependencies; any Node >= 18 runs it. A copy lives in
// every working copy at .appgov/appgov.mjs, so whichever coding agent opens the directory can drive the governed
// loop without installing anything. The record is kept by the Host at the centre (a Cloudflare Worker); this CLI
// sends it the working tree and brings the working copy in line with it afterwards.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";

// The directory under each app directory that the Host keeps for itself (STATE_DIR in host/src/artifact.ts), and
// the one where pneuma-framework keeps every version and the history (FRAMEWORK_DIR there). A test checks both.
const STATE_DIR = ".appgov";
const FRAMEWORK_DIR = ".pneuma-framework";
// What is never part of a version, as the Host's TREE in host/src/artifact.ts says; a test checks the two agree.
const IGNORED_DIRS = new Set(["node_modules", FRAMEWORK_DIR, STATE_DIR, ".git", "dist", ".work", ".claude", ".codex", ".vscode", ".idea", ".pneuma"]);
const IGNORED_FILES = new Set([".env", ".env.local", ".DS_Store"]);
const IGNORED_PATHS = new Set(["data"]);
/** The centre's address and the agent token this working copy uses. Never part of a version, never committed. */
const CENTRE_FILE = "centre.json";
/** What the working copy was last brought in line with: the version and a signature of its files. */
const SYNCED_FILE = "synced.json";

const USAGE = `usage: node ${STATE_DIR}/appgov.mjs <command> [--app <name>] [--agent <name>] [--host <url>] [--json] [--timing]

  status [<name>]        active version, address, files changed here and not submitted, changes waiting for the owner
  history [<name>]       every attempt so far, oldest first, with what was guaranteed for each
  submit "<intent>"      send this working copy to the centre, take it through the Host's loop, and release it
  discard                put the working tree back to the active version, at the centre and here
  undo "<why>"           go back one version; again to go further back
    [--to <version>]     go straight back to an earlier version
    [--accept-one-way]   owner only: confirm going back past a one-way change
  approve <change-id>    owner only
  deny <change-id> [why] owner only
  preview <change-id>    publish a waiting change's preview again once it has ended itself
  create <name>          create and publish a new app, and put its working copy in ./<name> (or --into <dir>)
  fetch [<name>]         in a working copy: bring it up to date (refused while you have edits it would overwrite).
                         elsewhere: put the app's working copy in ./<name> (or --into <dir>)
  list                   every app the centre keeps

Owner only:
  login [--key-file <f>] sign in with the owner key the installer wrote; the session is kept next to that file
  logout
  token create [--label <l>] [--days <n>] --write <dir>
                         create an agent token and write it, with the centre's address, to <dir>/${STATE_DIR}/${CENTRE_FILE}
  token list | token revoke <id>
  container [<name>] [stop]
                         whether the app's Host container runs; stop it (the next operation starts from R2)

The centre: --host <url>, else APPGOV_HOST, else ${STATE_DIR}/${CENTRE_FILE} here or in a directory above.
The agent token: APPGOV_TOKEN, else ${STATE_DIR}/${CENTRE_FILE}. The owner's session: from login, kept in
${join("~", STATE_DIR, "hosts", "<host>")} (APPGOV_HOME moves ${join("~", STATE_DIR)}).
APPGOV_AGENT names the agent for the history.`;

const VALUE_FLAGS = {
  "--app": ["app", "--app takes the app's name"],
  "--agent": ["agent", "--agent takes the agent's name"],
  "--to": ["to", "--to takes a version, e.g. v3"],
  "--host": ["host", "--host takes the centre's address, e.g. https://appgov-host.example.workers.dev"],
  "--one-way": ["oneWay", '--one-way takes "<what putting files back would not undo>"'],
  "--into": ["into", "--into takes a directory"],
  "--key-file": ["keyFile", "--key-file takes the owner credentials file the installer wrote"],
  "--label": ["label", "--label takes a name for the token"],
  "--days": ["days", "--days takes how many days the token is valid"],
  "--write": ["write", "--write takes the directory to write the token to"],
};

function parse(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") flags.json = true;
    else if (arg === "--timing") flags.timing = true;
    else if (arg === "--accept-one-way") flags.acceptOneWay = true;
    else if (Object.hasOwn(VALUE_FLAGS, arg)) {
      const [key, missing] = VALUE_FLAGS[arg];
      if (i + 1 >= argv.length) fail(missing);
      flags[key] = argv[++i];
    } else rest.push(arg);
  }
  return { flags, rest };
}

function fail(message, code = 1) {
  console.error(`appgov: ${message}`);
  process.exit(code);
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/** Write a file only its owner can read. */
function writePrivate(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** The working copy this command runs in: the nearest directory above with .appgov/app.json. */
function findCopy(start) {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    const info = readJson(join(dir, STATE_DIR, "app.json"));
    if (info?.app_id) return { dir, app: info.app_id };
    if (dirname(dir) === dir) return null;
  }
}

/** The nearest .appgov/centre.json here or above. */
function findCentre(start) {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    const file = join(dir, STATE_DIR, CENTRE_FILE);
    const record = readJson(file);
    if (typeof record?.url === "string" && record.url) return { ...record, file };
    if (dirname(dir) === dir) return null;
  }
}

const clean = (url) => String(url).trim().replace(/\/+$/, "");
const appgovHome = () => process.env.APPGOV_HOME?.trim() || join(homedir(), STATE_DIR);

// --- what a version holds, as the Host decides it ---------------------------------------------------------

/** Every file of the working tree that a version holds, relative, sorted. Symbolic links are left out, as the Host leaves them out. */
function sourceFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = full.slice(root.length + 1).split(sep).join("/");
      if (IGNORED_PATHS.has(rel)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile() && !IGNORED_FILES.has(entry.name)) out.push(rel);
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
}

const isSource = (path) => !path.startsWith(`${FRAMEWORK_DIR}/`) && !path.startsWith(`${STATE_DIR}/`);

function signature(entries) {
  const hash = createHash("sha1");
  for (const [path, body] of [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) hash.update(`${path}\0${createHash("sha1").update(body).digest("hex")}\n`);
  return hash.digest("hex");
}

const localEntries = (root) => sourceFiles(root).map((path) => [path, readFileSync(join(root, path))]);

/** Files that differ between the working tree and a version's directory in .pneuma-framework/versions/. */
function changedAgainst(root, version) {
  const versionDir = join(root, FRAMEWORK_DIR, "versions", version ?? "");
  if (!version || !existsSync(versionDir)) return null;
  const here = new Map(localEntries(root));
  const there = new Map(sourceFiles(versionDir).map((path) => [path, readFileSync(join(versionDir, path))]));
  const changed = [];
  for (const [path, body] of here) if (!there.has(path) || !there.get(path).equals(body)) changed.push(path);
  for (const path of there.keys()) if (!here.has(path)) changed.push(path);
  return changed.sort();
}

/**
 * Bring the working copy in `dir` in line with the centre's `copy`. `.pneuma-framework/` and the Host's files in
 * `.appgov/` always follow the centre. The source files follow it only when nothing here would be lost: they are
 * what the copy was last brought in line with, what this command sent, or already what the centre holds.
 */
function applyCopy(dir, copy, uploaded) {
  const incoming = copy.files.map((file) => [file.path, Buffer.from(file.body, "base64")]);
  const incomingSource = incoming.filter(([path]) => isSource(path));
  const synced = readJson(join(dir, STATE_DIR, SYNCED_FILE));
  const here = signature(localEntries(dir));
  const there = signature(incomingSource);
  const replace = !synced || here === synced.signature || here === uploaded || here === there;
  for (const [path] of incoming) {
    if (path.split("/").some((part) => !part || part === "." || part === "..") || path.startsWith("/")) fail(`the centre sent a path this CLI will not write: ${path}`, 3);
  }
  rmSync(join(dir, FRAMEWORK_DIR), { recursive: true, force: true });
  for (const [path, body] of incoming) {
    if (isSource(path) && !replace) continue;
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  if (replace) {
    const wanted = new Set(incomingSource.map(([path]) => path));
    for (const path of sourceFiles(dir)) if (!wanted.has(path)) rmSync(join(dir, path), { force: true });
    writePrivate(join(dir, STATE_DIR, SYNCED_FILE), { app: copy.app, active_version: copy.active_version, signature: there, at: new Date().toISOString() });
  } else {
    // The version moved on; the edits here stay, and a submit from them is refused as behind until fetch.
    const kept = readJson(join(dir, STATE_DIR, SYNCED_FILE)) ?? {};
    writePrivate(join(dir, STATE_DIR, SYNCED_FILE), { ...kept, app: copy.app });
  }
  return replace;
}

// --- the centre -------------------------------------------------------------------------------------------

const { flags, rest } = parse(process.argv.slice(2));
const [command, ...args] = rest;
if (!command || command === "help" || command === "--help") {
  console.log(USAGE);
  process.exit(command ? 0 : 1);
}
const COPY = findCopy(process.cwd());
const CENTRE_RECORD = findCentre(process.cwd());
const CENTRE = flags.host ? clean(flags.host) : process.env.APPGOV_HOST ? clean(process.env.APPGOV_HOST) : CENTRE_RECORD ? clean(CENTRE_RECORD.url) : null;
const CENTRE_SOURCE = flags.host
  ? "That address came from the --host flag."
  : process.env.APPGOV_HOST
    ? "That address came from APPGOV_HOST."
    : CENTRE_RECORD
      ? `That address is in ${CENTRE_RECORD.file}.`
      : "";
const TOKEN = process.env.APPGOV_TOKEN?.trim() || (CENTRE_RECORD && (!CENTRE || clean(CENTRE_RECORD.url) === CENTRE) ? CENTRE_RECORD.token : undefined);

/** The owner credentials file the installer wrote for this centre, and the session file next to it. */
function ownerFiles() {
  if (flags.keyFile) {
    const file = resolve(flags.keyFile);
    return { keyFile: file, sessionFile: join(dirname(file), "session.json") };
  }
  const hosts = join(appgovHome(), "hosts");
  if (!existsSync(hosts)) return null;
  for (const name of readdirSync(hosts)) {
    const file = join(hosts, name, "owner.json");
    const record = readJson(file);
    if (record && (!CENTRE || clean(record.url) === CENTRE)) return { keyFile: file, sessionFile: join(hosts, name, "session.json"), url: clean(record.url) };
  }
  return null;
}

function ownerSession() {
  const files = ownerFiles();
  if (!files) return null;
  const session = readJson(files.sessionFile);
  if (!session?.session || Date.parse(session.expires_at) <= Date.now()) return null;
  if (CENTRE && clean(session.url) !== CENTRE) return null;
  return session;
}

/** Which credential a request carries: the owner's session for owner commands when there is one, else the agent token. */
function credential(owner) {
  const session = ownerSession();
  if (owner && session) return session.session;
  if (TOKEN) return TOKEN;
  if (session) return session.session;
  return null;
}

// node:http, not fetch: undici stops waiting for response headers after 300 s, and the centre holds create, submit,
// approve and undo open for the whole check (up to 600 s). No timeout of any kind here.
function request(method, url, payload, secret) {
  return new Promise((settle) => {
    const body = payload ? JSON.stringify(payload) : method === "GET" ? undefined : "{}";
    const tls = url.protocol === "https:";
    let connected = false;
    const lost = (err) => settle({ err, connected: true });
    const aborted = () => Object.assign(new Error("aborted"), { code: "ECONNRESET" });
    const headers = { ...(secret ? { authorization: `Bearer ${secret}` } : {}), ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}) };
    const req = (tls ? httpsRequest : httpRequest)(url, { method, agent: false, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => (res.complete ? settle({ status: res.statusCode, timing: res.headers["x-appgov-timing"], text: Buffer.concat(chunks).toString("utf8") }) : lost(aborted())));
      res.on("error", lost);
      res.on("close", () => res.complete || lost(aborted()));
    });
    req.on("socket", (socket) => socket.once(tls ? "secureConnect" : "connect", () => (connected = true)));
    req.on("error", (err) => settle({ err, connected }));
    req.end(body);
  });
}

const REFUSAL_HINTS = {
  crosses_one_way_change: `Stop and show this to the user. Going back past a one-way change is the owner's decision: signed in as the owner (node ${STATE_DIR}/appgov.mjs login), they run: node ${STATE_DIR}/appgov.mjs undo --accept-one-way "<why>" (with the same --to, if one was given).`,
  plan_changed: "Nothing changed. Run the same undo again to see what going back does now, then confirm that.",
  owner_required: "Stop and show this to the user: it is theirs to do, signed in as the owner. Do not look for a way around it.",
  working_copy_behind: `Run node ${STATE_DIR}/appgov.mjs fetch, then make the change again.`,
  unauthenticated: `The centre did not accept the credential. An agent token lives in ${STATE_DIR}/${CENTRE_FILE} (or APPGOV_TOKEN); the owner creates one with token create. Ask the user.`,
};
const refusalCode = (reason) => (reason === "crosses_one_way_change" || reason === "owner_required" ? 2 : 3);
const refusalText = (data, fallback) => `${data.error ?? fallback}${REFUSAL_HINTS[data.reason] ? `\n${REFUSAL_HINTS[data.reason]}` : ""}`;

async function send(method, path, payload, { owner = false } = {}) {
  if (!CENTRE) fail(`no centre to talk to: there is no --host flag, no APPGOV_HOST, and no ${STATE_DIR}/${CENTRE_FILE} here or above. Ask the user for the centre's address and an agent token.`, 3);
  let url;
  try {
    url = new URL(`${CENTRE}${path}`);
  } catch {}
  if (url?.protocol !== "https:" && url?.protocol !== "http:") fail(`the centre's address must be an https:// address, not "${CENTRE}". ${CENTRE_SOURCE}`, 3);
  const secret = credential(owner);
  if (!secret) fail(`no credential for the centre at ${CENTRE}: no APPGOV_TOKEN, no token in ${STATE_DIR}/${CENTRE_FILE}, and no owner session. Ask the user for an agent token.`, 3);
  const began = Date.now();
  const { err, connected, status, timing, text } = await request(method, url, payload, secret);
  if (err) {
    const code = err.code ?? err.message;
    if (connected) {
      fail(
        method === "GET"
          ? `the connection to the centre at ${CENTRE} was lost before it answered (${code}). Nothing was changed; run the command again.`
          : `the connection to the centre at ${CENTRE} was lost while it was working on the request (${code}). It may still finish, so the change may still be released: run status and history before submitting again.`,
        3,
      );
    }
    if (code === "EPERM" || code === "EACCES") fail(`the sandbox this command runs in blocks the connection to the centre at ${CENTRE} (${code}). Nothing was sent. Run this command with network access (ask the user for permission), then repeat it.`, 3);
    fail(`cannot reach the centre at ${CENTRE} (${code}). ${CENTRE_SOURCE} Ask the user, do not start anything yourself.`, 3);
  }
  if (flags.timing) console.error(`appgov: ${method} ${path} took ${Date.now() - began} ms${timing ? ` (${timing})` : ""}`);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text.slice(0, 300) };
  }
  return { status, data };
}

async function call(method, path, payload, options) {
  const { status, data } = await send(method, path, payload, options);
  if (status < 200 || status >= 300) fail(refusalText(data, `${method} ${path} answered ${status}`), refusalCode(data.reason));
  return data;
}

/** Bring the working copy in line with the copy the centre sent back, and say so when edits here were kept. */
function sync(dir, data, uploaded) {
  if (!dir || !data?.working_copy) return;
  const replaced = applyCopy(dir, data.working_copy, uploaded);
  if (!replaced) console.log(`kept your edits in ${dir}: they differ from what was sent and from the centre. The record in ${FRAMEWORK_DIR}/ is up to date; run fetch once the edits are submitted or discarded.`);
}

// --- printing, as the local edition's CLI prints ----------------------------------------------------------

const readableTime = (iso) => (typeof iso === "string" && iso.length >= 16 ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "an unknown date");
const out = (data, human) => (flags.json ? console.log(JSON.stringify(data, null, 2)) : human(data));
const clip = (value, max = 80) => {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const items = (value) => (Array.isArray(value) ? value : []);

const REJECTION_HINTS = {
  protected_file_changed: `These paths are protected (see AGENTS.md). Restore them from ${FRAMEWORK_DIR}/versions/<active version>/ and submit again.`,
  outside_writable_roots: "A change may only touch the writable roots listed in AGENTS.md and appgov.scaffold.json. Move these files under app/ or tests/, or remove them, and submit again.",
  invalid_manifest: "Fix pneuma-space.json so that it parses, and submit again.",
  preview_refused: "Do not change the code for this: nothing was found wrong with it. Show this to the user.",
  no_change: "The working tree is identical to the active version, so there is nothing to release.",
  base_changed: "Another change was released while this one was being checked. Run fetch, then submit again.",
  draft_changed_after_check: "The change's files were altered after they were checked. Run status and submit again.",
};
const releaseAgain = (version) =>
  `Fix the cause and submit again, or undo. Submitting with no new edits releases ${version} as it is; with new edits, it records a new version on top of ${version} and releases both.`;
const NOTHING_CHECKED = "Nothing checked or approved this change: the Host recorded it and published it as it was.";

function previewLine(preview, changeId) {
  if (preview.state === "standing") return `preview: ${preview.address}${preview.expires_at ? ` (it ends itself at ${readableTime(preview.expires_at)})` : ""}`;
  if (preview.state === "unknown") return `preview: unknown; ${preview.note}. Nothing was changed; ask again in a minute.`;
  return `preview: none standing; ${preview.note}. Publish it again with: node ${STATE_DIR}/appgov.mjs preview ${changeId}`;
}

function printChange(result) {
  if (result.status === "published") {
    console.log(`published ${result.version} at ${result.address}`);
    if (result.released_as_is) console.log(`${result.version} was recorded earlier and did not go live then; it went live now, as it was. No new version was recorded.`);
    if (result.changed_paths?.length) console.log(`changed: ${result.changed_paths.join(", ")}`);
    if (!result.guarantees?.length) console.log(NOTHING_CHECKED);
    else console.log(`risks: ${result.risks.join(", ")}; approved by: ${result.approved_by.join(", ")}`);
    if (result.one_way) console.log(`ONE-WAY: ${String(result.one_way).replace(/\.+$/, "")}. Going back past this version needs the owner's confirmation.`);
    if (result.note) console.log(result.note);
    if (result.test_warning) console.log(result.test_warning);
    return 0;
  }
  if (result.status === "release_failed") {
    console.log(`recorded ${result.version}, but it did not go live (${result.reason}).`);
    if (result.detail) console.log(result.detail);
    if (result.address_note && !String(result.detail ?? "").includes(result.address_note)) console.log(`${result.address_note}.`);
    if (REJECTION_HINTS[result.reason]) console.log(REJECTION_HINTS[result.reason]);
    console.log(releaseAgain(result.version));
    return 1;
  }
  if (result.status === "needs_approval") {
    console.log(`needs_approval ${result.change_id}: nothing was released.`);
    console.log(`risks: ${result.risks.join(", ")}`);
    for (const line of result.disclosure) console.log(`  - ${line}`);
    if (result.test_warning) console.log(result.test_warning);
    if (result.preview) console.log(previewLine(result.preview, result.change_id));
    const look = result.preview ? "They can open the preview, then decide, signed in as the owner, with" : "They decide, signed in as the owner, with";
    console.log(`Show this to the owner. ${look}: node ${STATE_DIR}/appgov.mjs approve ${result.change_id}   (or deny)`);
    return 2;
  }
  console.log(`rejected (${result.reason}): nothing was released.`);
  if (result.detail) console.log(result.detail);
  if (REJECTION_HINTS[result.reason]) console.log(REJECTION_HINTS[result.reason]);
  return 1;
}

function printApps({ governance, apps }) {
  if (!apps.length) return console.log(`no apps yet. Create one with: node ${STATE_DIR}/appgov.mjs create <name>`);
  const waiting = apps.flatMap((app) => items(app.pending).map(() => app.app_id));
  console.log(
    `${apps.length} app${apps.length === 1 ? "" : "s"} at the centre ${CENTRE}, in ${governance} mode. ` +
      (waiting.length ? `Waiting for the owner: ${waiting.length} change${waiting.length === 1 ? "" : "s"} (${[...new Set(waiting)].join(", ")}).` : "Nothing waits for the owner."),
  );
  const width = Math.max(...apps.map((app) => String(app.app_id).length));
  for (const app of apps) {
    console.log("");
    if (app.error) {
      console.log(`${String(app.app_id).padEnd(width)}  could not be read: ${app.error}`);
      continue;
    }
    console.log(`${String(app.app_id).padEnd(width)}  ${app.active_version ?? "unpublished"}  ${app.address}`);
    const last = app.last_change;
    if (last) console.log(`  last change ${readableTime(last.at)} by ${clip(last.agent, 40)}: "${clip(last.intent)}" (${last.kind} ${last.outcome}${last.version ? ` ${last.version}` : ""})`);
    for (const p of items(app.pending)) console.log(`  waiting for the owner: ${p.change_id} "${clip(p.intent)}" (${items(p.risks).join(", ")})`);
    if (app.serving_uncertain) console.log(`  the Host cannot vouch for what the address serves: ${app.serving_uncertain}`);
    else if (app.serves_other_version) console.log(`  the address serves ${app.serving_version}, not ${app.active_version}: the last release did not go live`);
  }
}

const AGENT_MARKERS = [
  { agent: "claude-code", markers: (env) => ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"].filter((key) => env[key]) },
  { agent: "codex", markers: (env) => ["CODEX_THREAD_ID", "CODEX_TOOL_CALL_ID"].filter((key) => env[key]) },
];

function identifyAgent() {
  if (flags.agent?.trim()) return { name: flags.agent.trim(), source: "--agent" };
  if (process.env.APPGOV_AGENT?.trim()) return { name: process.env.APPGOV_AGENT.trim(), source: "APPGOV_AGENT" };
  const found = AGENT_MARKERS.map(({ agent, markers }) => ({ agent, markers: markers(process.env) })).filter((candidate) => candidate.markers.length);
  if (found.length === 1) return { name: found[0].agent, source: "detected", markers: found[0].markers };
  if (found.length > 1) return { name: "unknown", source: "ambiguous", candidates: found };
  return { name: "unknown", source: "none" };
}

const agentFields = (agent) => ({
  agent: agent.name,
  agent_source: agent.source,
  ...(agent.markers ? { agent_markers: agent.markers } : {}),
  ...(agent.candidates ? { agent_candidates: agent.candidates } : {}),
});

/** Write a fresh working copy into `dir`, which must be empty or absent, with the centre's address and the token. */
function newCopy(dir, copy) {
  if (existsSync(dir) && readdirSync(dir).length) fail(`${dir} is not empty; name another directory with --into <dir>`);
  mkdirSync(dir, { recursive: true });
  applyCopy(dir, copy);
  if (TOKEN) writePrivate(join(dir, STATE_DIR, CENTRE_FILE), { url: CENTRE, token: TOKEN });
  console.log(`working copy of ${copy.app} (${copy.active_version}) in ${dir}${TOKEN ? `; the centre's address and the agent token are in ${join(dir, STATE_DIR, CENTRE_FILE)} (keep it out of git)` : ""}. Open it with your coding agent.`);
}

// --- commands that need no app ----------------------------------------------------------------------------

if (command === "login") {
  const files = ownerFiles();
  if (!files) fail(`no owner credentials file for ${CENTRE ?? "this centre"} in ${join(appgovHome(), "hosts")}; the installer wrote it there. Pass --key-file <file>.`);
  const record = readJson(files.keyFile);
  if (!record?.key || !record?.url) fail(`${files.keyFile} is not an owner credentials file`);
  const url = clean(record.url);
  const { err, status, text } = await request("POST", new URL(`${url}/auth/login`), { key: record.key });
  if (err) fail(`cannot reach the centre at ${url} (${err.code ?? err.message})`, 3);
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {}
  if (status !== 200) fail(data.error ?? `sign-in answered ${status}`, 3);
  writePrivate(files.sessionFile, { url, session: data.session, expires_at: data.expires_at });
  console.log(`signed in to ${url} as the owner until ${readableTime(data.expires_at)}; the session is in ${files.sessionFile}`);
  process.exit(0);
}

if (command === "logout") {
  const files = ownerFiles();
  if (files && ownerSession()) await send("POST", "/auth/logout", {}, { owner: true });
  if (files) rmSync(files.sessionFile, { force: true });
  console.log("signed out");
  process.exit(0);
}

if (command === "token") {
  const [sub, id] = args;
  if (!ownerSession()) fail(`tokens are the owner's: sign in first with node ${STATE_DIR}/appgov.mjs login`, 2);
  if (sub === "list") {
    out(await call("GET", "/tokens", undefined, { owner: true }), ({ tokens }) => {
      if (!tokens.length) console.log("no agent tokens");
      for (const t of tokens) console.log(`${t.id}  ${t.label}  created ${readableTime(new Date(t.created_at).toISOString())}  ${t.revoked_at ? "revoked" : `valid until ${readableTime(new Date(t.expires_at).toISOString())}`}`);
    });
    process.exit(0);
  }
  if (sub === "revoke") {
    if (!id) fail("token revoke takes <id>");
    out(await call("DELETE", `/tokens/${encodeURIComponent(id)}`, undefined, { owner: true }), () => console.log(`revoked ${id}`));
    process.exit(0);
  }
  if (sub === "create") {
    // Never printed: the token goes straight into the file the agent's CLI reads.
    if (!flags.write) fail("token create writes the token to <dir>/.appgov/centre.json and never prints it: pass --write <dir>");
    const file = join(resolve(flags.write), STATE_DIR, CENTRE_FILE);
    if (existsSync(file)) fail(`${file} exists already; revoke the token in it first, or write to another directory`);
    const data = await call("POST", "/tokens", { label: flags.label ?? "agent", ...(flags.days ? { expires_in_days: Number(flags.days) } : {}) }, { owner: true });
    writePrivate(file, { url: CENTRE, token: data.token });
    console.log(`created agent token ${data.id} (${data.label}), valid until ${readableTime(new Date(data.expires_at).toISOString())}; written to ${file}. Keep that file out of git.`);
    process.exit(0);
  }
  fail("token takes create, list or revoke");
}

if (command === "list") {
  out(await call("GET", "/apps"), printApps);
  process.exit(0);
}

if (command === "create") {
  if (!args[0]) fail("create takes <name>");
  const dir = resolve(flags.into ?? args[0]);
  if (existsSync(dir) && readdirSync(dir).length) fail(`${dir} is not empty; name another directory with --into <dir>`);
  const result = await call("POST", "/apps", { name: args[0] });
  let code = 0;
  out(result, (data) => (code = printChange(data)));
  if (result.status === "published" && result.working_copy) newCopy(dir, result.working_copy);
  process.exit(flags.json ? (result.status === "published" ? 0 : 1) : code);
}

if (command === "fetch" && !COPY) {
  const name = args[0] ?? flags.app;
  if (!name) fail("outside a working copy, fetch takes the app's name: fetch <name>");
  const copy = await call("GET", `/apps/${encodeURIComponent(name)}/folder`);
  newCopy(resolve(flags.into ?? name), copy);
  process.exit(0);
}

// --- commands on one app ----------------------------------------------------------------------------------

const words = command === "container" ? args.filter((word) => word !== "stop") : args;
const named = (command === "status" || command === "history" || command === "container") && words[0] ? words[0] : undefined;
const app = flags.app ?? named ?? COPY?.app;
if (!app) fail(`not inside a working copy (no ${STATE_DIR}/app.json here or above). Name the app with --app <name> (status and history also take it as a word); list shows every app.`);
const base = `/apps/${app}`;
// The working copy, when this command runs in the app's own.
const DIR = COPY?.app === app ? COPY.dir : null;
const synced = DIR ? readJson(join(DIR, STATE_DIR, SYNCED_FILE)) : null;
const baseVersion = synced?.active_version ?? undefined;

switch (command) {
  case "status": {
    const s = await call("GET", base);
    const here = DIR ? changedAgainst(DIR, s.active_version) : null;
    out({ ...s, ...(here ? { uncommitted_here: here } : {}) }, () => {
      console.log(`${s.app_id}: ${s.active_version ?? "unpublished"} at ${s.address}`);
      if (s.serving_uncertain) console.log(`the Host cannot vouch for what the address serves: ${s.serving_uncertain}`);
      else if (s.serving_version && s.serving_version !== s.active_version) {
        console.log(`the address serves ${s.serving_version}, not ${s.active_version}: the last release did not go live. Submitting with no new edits releases ${s.active_version} as it is.`);
      }
      console.log(`previous: ${s.previous_version ? `${s.previous_version} (undo goes back here)` : "none (this is the first version)"}; owner: ${s.owner}; governance: ${s.governance}`);
      console.log(s.governance_note);
      console.log(`on PneumaSpace: ${s.space_manager.note}`);
      if (DIR) {
        if (baseVersion && baseVersion !== s.active_version) console.log(`this working copy is on ${baseVersion}; the centre is on ${s.active_version}. Run fetch before changing anything.`);
        console.log(`changed here, not submitted: ${here === null ? "unknown (this working copy does not hold the active version's files; run fetch)" : here.length ? here.join(", ") : "none"}`);
      } else console.log(`uncommitted at the centre: ${s.uncommitted.length ? s.uncommitted.join(", ") : "none"}`);
      for (const p of s.pending) {
        console.log(`waiting for the owner: ${p.change_id} "${p.intent}" (${p.risks.join(", ")})`);
        for (const line of p.disclosure) console.log(`  - ${line}`);
        if (p.tests) console.log(`  tests: ${p.tests.note}`);
        if (p.test_warning) console.log(`  ${p.test_warning}`);
        if (p.preview) console.log(`  ${previewLine(p.preview, p.change_id)}`);
      }
      for (const line of s.malformed_pending ?? []) console.log(line);
    });
    break;
  }
  case "history":
    out(await call("GET", `${base}/history`), ({ history }) => {
      for (const h of history) {
        const where = h.version ? ` -> ${h.version}` : "";
        const why = h.reason ? ` (${h.reason})` : "";
        console.log(`${h.at} ${h.kind} ${h.outcome}${where} by ${h.agent} [${h.control}]: ${h.intent}${why}`);
        if (h.changed_paths?.length) console.log(`    files: ${h.changed_paths.join(", ")}`);
        if (h.approval) console.log(`    approval: ${h.approval.reason_code} by ${h.approval.by.join(", ") || "nobody yet"} (${h.risks?.join(", ") ?? ""})`);
        const tests = h.checks?.find((check) => check.id === "npm-test");
        if (tests?.coverage) console.log(`    tests (${tests.status}): ${tests.coverage.note}`);
        if (h.kind !== "snapshot") console.log(`    guarantees: ${h.guarantees.length ? h.guarantees.join(", ") : "none (recorded only)"}`);
        if (h.one_way) console.log(`    ONE-WAY: ${h.one_way.reason}`);
        if (h.one_way_crossed) console.log(`    went back past one-way ${h.one_way_crossed.versions.join(", ")}: code only${h.confirmed_by ? `, confirmed by ${h.confirmed_by}` : ""}`);
        if (h.address_note) console.log(`    address: ${h.address_note}`);
        if (h.kept_edits?.length) console.log(`    working tree left as it was (edited meanwhile): ${h.kept_edits.join(", ")}`);
      }
    });
    break;
  case "submit": {
    if (!args[0]) fail('submit takes "<one sentence: what the user asked for>"');
    if (!DIR) fail("submit sends the files of a working copy: run it in the app's working copy");
    if (flags.oneWay !== undefined && !String(flags.oneWay).trim()) fail('--one-way takes "<what putting files back would not undo>"');
    const agent = identifyAgent();
    if (agent.source === "ambiguous") console.error('appgov: warning: markers of more than one agent are set, so this is recorded as agent "unknown". Say which agent you are with --agent <name> or APPGOV_AGENT=<name>.');
    const entries = localEntries(DIR);
    const uploaded = signature(entries);
    const result = await call("POST", `${base}/changes`, {
      intent: args.join(" "),
      ...agentFields(agent),
      ...(flags.oneWay !== undefined ? { one_way: flags.oneWay } : {}),
      ...(baseVersion ? { base_version: baseVersion } : {}),
      tree: { files: entries.map(([path, body]) => ({ path, body: body.toString("base64") })) },
    });
    sync(DIR, result, uploaded);
    let code = result.status === "published" ? 0 : result.status === "needs_approval" ? 2 : 1;
    out(result, (data) => (code = printChange(data)));
    process.exit(code);
  }
  case "discard": {
    // No base check: putting the centre's working tree back to its active version loses nothing that was released.
    const data = await call("POST", `${base}/discard`, {});
    // Discarding throws away the edits here too: that is what was asked for.
    if (DIR) writePrivate(join(DIR, STATE_DIR, SYNCED_FILE), { ...(synced ?? {}), signature: signature(localEntries(DIR)) });
    sync(DIR, data);
    out(data, (d) => console.log(`working tree is back at ${d.active_version}${d.restored.length ? `; restored: ${d.restored.join(", ")}` : ""}`));
    break;
  }
  case "undo": {
    const actor = identifyAgent();
    const payload = { reason: args.join(" ") || "undo", actor: actor.name, ...(flags.to ? { to: flags.to } : {}), ...(baseVersion ? { base_version: baseVersion } : {}) };
    let { status, data } = await send("POST", `${base}/undo`, payload);
    if (flags.acceptOneWay && status === 409 && data.reason === "crosses_one_way_change") {
      if (!ownerSession()) fail(`${data.error}\nGoing back past a one-way change is the owner's decision: sign in first with node ${STATE_DIR}/appgov.mjs login`, 2);
      console.log(data.error);
      if (process.stdin.isTTY) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question('Type "accept" to go back with the code only, leaving the stored data as it is: ').catch(() => "");
        rl.close();
        if (answer.trim() !== "accept") fail("not confirmed; nothing changed");
      }
      ({ status, data } = await send("POST", `${base}/undo`, { ...payload, actor: "owner", accept_one_way: true, ...(data.from ? { from: data.from } : {}) }, { owner: true }));
    }
    if (status < 200 || status >= 300) fail(refusalText(data, `POST ${base}/undo answered ${status}`), refusalCode(data.reason));
    sync(DIR, data);
    out(data, (d) => {
      console.log(`now on ${d.active_version} (was ${d.undone_version}) at ${d.address}.${d.undone.length > 1 ? ` Went back past ${d.undone.join(", ")}.` : ""}`);
      if (d.confirmed_by) console.log(`Code only; stored data was not put back, as ${d.confirmed_by} confirmed. This version may fail on it.`);
      else console.log("Code only; stored data was not rolled back.");
      if (d.note) console.log(d.note);
    });
    break;
  }
  case "approve":
  case "deny": {
    if (!args[0]) fail(`${command} takes <change-id>`);
    // The centre decides who may: only the owner's session. Without one, the agent token is sent and refused there.
    const status = await call("GET", base, undefined, { owner: true });
    const pending = status.pending.find((p) => p.change_id === args[0]);
    if (!pending) fail(`no change ${args[0]} is waiting`);
    console.log(`"${pending.intent}" by ${pending.agent}\nfiles: ${pending.changed_paths.join(", ")}\nrisks: ${pending.risks.join(", ")}`);
    for (const line of pending.disclosure) console.log(`  - ${line}`);
    if (pending.tests) console.log(`tests: ${pending.tests.note}`);
    if (pending.test_warning) console.log(pending.test_warning);
    if (pending.preview) console.log(previewLine(pending.preview, args[0]));
    if (process.stdin.isTTY && ownerSession()) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(`Type "${command}" to confirm: `).catch(() => "");
      rl.close();
      if (answer.trim() !== command) fail("not confirmed; nothing changed");
    }
    const result = await call("POST", `${base}/changes/${args[0]}/${command}`, { reason: args.slice(1).join(" ") || undefined }, { owner: true });
    sync(DIR, result);
    let code = 0;
    out(result, (data) => (code = command === "deny" ? (console.log("denied; nothing was released"), 0) : printChange(data)));
    process.exit(code);
  }
  case "preview":
    if (!args[0]) fail("preview takes <change-id>");
    out(await call("POST", `${base}/changes/${args[0]}/preview`, {}), (d) => {
      console.log(d.republished ? `published the preview of ${d.change_id} again.` : `the preview of ${d.change_id} still stands; nothing was published.`);
      console.log(previewLine(d.preview, d.change_id));
    });
    break;
  case "fetch": {
    const copy = await call("GET", `${base}/folder`);
    const synced = readJson(join(DIR, STATE_DIR, SYNCED_FILE));
    const here = signature(localEntries(DIR));
    const there = signature(copy.files.filter((f) => isSource(f.path)).map((f) => [f.path, Buffer.from(f.body, "base64")]));
    if (synced && here !== synced.signature && here !== there) {
      fail(`this working copy has edits fetch would overwrite (${(changedAgainst(DIR, synced.active_version) ?? ["unknown files"]).join(", ")}). Submit them, or discard them, first.`);
    }
    applyCopy(DIR, copy);
    console.log(`working copy is on ${copy.active_version}, as the centre is`);
    break;
  }
  case "container": {
    const stop = args.includes("stop");
    out(await call(stop ? "POST" : "GET", `${base}/container${stop ? "/stop" : ""}`, stop ? {} : undefined, { owner: true }), (d) =>
      console.log(stop ? (d.stopped ? `stopped the Host's container of ${app}` : `the Host's container of ${app} was not running`) : `the Host's container of ${app} is ${d.running ? "running" : "not running"}${d.image ? `; image ${d.image}` : ""}${d.build ? `; Host build ${d.build}` : ""}`),
    );
    break;
  }
  default:
    fail(`unknown command "${command}"\n${USAGE}`);
}
