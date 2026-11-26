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
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

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
// The level of the centre's API this CLI is written for. The centre sends its own in the `appgov-api` header of every
// answer (API_LEVEL in src/protocol.ts; a test checks the two agree). At any other level this CLI refuses to go on,
// except `update`, which replaces it with the centre's own.
const HOST_API_LEVEL = 1;
const API_HEADER = "appgov-api";
/** This file, as a command run from the current directory: every hint this CLI prints names a file that is there. */
const SELF = (() => {
  const file = fileURLToPath(import.meta.url);
  const rel = relative(process.cwd(), file);
  const path = rel && !isAbsolute(rel) ? rel : file;
  return /[\s"'$`\\]/.test(path) ? JSON.stringify(path) : path;
})();

const USAGE = `usage: node ${SELF} <command> [--app <name>] [--agent <name>] [--host <url>] [--owner] [--json] [--timing]

  status [<name>]        active version, address, files changed here and not submitted, changes waiting for the owner,
    [--check]            and whether the app is on PneumaSpace: as last confirmed, or asked now with --check
  history [<name>]       every attempt so far, oldest first, with what was guaranteed for each
  submit "<intent>"      send this working copy to the centre, take it through the Host's loop, and release it
    [--one-way "<what is lost>"]  this change deletes or rewrites data the app already stored, in any
                         storage: say what is lost. The owner then decides it
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
  list [--check]         every app the centre keeps, and whether each is on PneumaSpace (--check: asked now)
  update                 replace this CLI with the centre's own (when it says it is at another API level)
  connect <code> --host <url>
                         connect this directory with a one-time code from the owner page: a token in
                         ${STATE_DIR}/${CENTRE_FILE} (never printed), this centre's CLI and an AGENTS.md (with CLAUDE.md).
                         The page gives the whole command: curl -fsS <url>/connect | node - <code>

Owner only:
  login [--key-file <f>] sign in with the owner key the installer wrote; the session is kept next to that file
  logout
  token create [--label <l>] [--days <n>] --write <dir>
                         create a token and write it, with the centre's address, to <dir>/${STATE_DIR}/${CENTRE_FILE}
                         and, beside it, this centre's own CLI (.appgov/appgov.mjs) and an AGENTS.md (with CLAUDE.md)
                         that tell an agent started in <dir> what it is and how to work there
  token list | token revoke <id>
  container [<name>] [stop]
                         whether the app's Host container runs; stop it (the next operation starts from R2)
  take-down [<name>]     stop serving the app and keep everything: PneumaSpace keeps it removed, with its stored
                         data, and the centre keeps its record. Agents' submits are refused meanwhile
  bring-back [<name>]    serve it again, with the data PneumaSpace kept
  publish-again [<name>] create it again on PneumaSpace from its current version, once PneumaSpace no longer has
                         it: it starts with no stored data
  clear [<name>]         forget the app here (type its name), once it does not serve. On this edition the app
                         stays on PneumaSpace, removed, with its stored data, until you purge it in PneumaSpace's
                         console as its owner: the Host's token may not purge

Who acts: a command that changes something goes with the token and is recorded as the agent's, unless it acts
as the owner: approve, deny, undo --accept-one-way, token create and revoke, container stop, take-down,
bring-back, publish-again and clear, and create, submit,
discard, undo or preview given --owner. Those send the owner's session, and only after a person in an interactive
terminal types the command's name; without a terminal they are refused before anything is sent. login needs a
terminal too. Reading (status, history, list, fetch) uses the token, or the owner's session when there is none.

The centre: --host <url>, else APPGOV_HOST, else ${STATE_DIR}/${CENTRE_FILE} here or in a directory above.
The token: APPGOV_TOKEN, else ${STATE_DIR}/${CENTRE_FILE}. The owner's session: from login, kept in
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
    else if (arg === "--owner") flags.owner = true;
    else if (arg === "--check") flags.check = true;
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

/**
 * Which credential a request carries. As the owner: the owner's session, never the agent token, so what the owner does
 * is recorded as theirs. Otherwise the agent token, so what an agent does is recorded as the agent's; only a read, which
 * changes nothing and is not recorded, may fall back to the owner's session when there is no token.
 */
function credential(owner, method) {
  if (owner) return ownerSession()?.session ?? null;
  if (TOKEN) return TOKEN;
  if (method === "GET") return ownerSession()?.session ?? null;
  return null;
}

/** Whether a person can answer here. Coding agents run commands without an interactive terminal. */
const TERMINAL = Boolean(process.stdin.isTTY);
const NOT_FOR_AGENTS = "If you are a coding agent: stop and show this to the user. It is theirs to do; do not look for a way around it.";

/**
 * Before anything that changes something goes out as the owner: a person at an interactive terminal, the owner's
 * session, and `word` typed. This keeps an honest agent on the owner's machine, which can read the session file, from
 * finishing the owner's part itself, as the local edition's terminal check does. It is not a lock (see the README).
 */
async function confirmAsOwner(word, what) {
  if (!TERMINAL) fail(`${what} is the owner's to do, by a person in a terminal; this command has none, so nothing was sent. ${NOT_FOR_AGENTS}`, 2);
  if (!ownerSession()) fail(`${what} is the owner's to do: sign in first, in your terminal, with node ${SELF} login. Nothing was sent.`, 2);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Ctrl+D or Ctrl+C at the prompt rejects the question; that is a "no", not a crash.
  const answer = await rl.question(`Type "${word}" to confirm, as the owner: `).catch(() => "");
  rl.close();
  if (answer.trim() !== word) fail("not confirmed; nothing changed");
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
      res.on("end", () =>
        res.complete ? settle({ status: res.statusCode, level: res.headers[API_HEADER], timing: res.headers["x-appgov-timing"], host: res.headers["x-appgov-host"], text: Buffer.concat(chunks).toString("utf8") }) : lost(aborted()),
      );
      res.on("error", lost);
      res.on("close", () => res.complete || lost(aborted()));
    });
    req.on("socket", (socket) => socket.once(tls ? "secureConnect" : "connect", () => (connected = true)));
    req.on("error", (err) => settle({ err, connected }));
    req.end(body);
  });
}

/**
 * Stop unless the centre speaks the API level this CLI is written for: an answer from a centre at another level may
 * lack what this CLI relies on, or mean something else. `update` replaces this CLI with the centre's own.
 */
function checkLevel(level, url) {
  if (command === "update" || String(level ?? "") === String(HOST_API_LEVEL)) return;
  const centre = url.origin;
  if (level === undefined || Number(level) < HOST_API_LEVEL) {
    fail(
      `the centre at ${centre} ${level === undefined ? "does not say which API level it speaks, so it is older than this CLI" : `speaks API level ${level}, older than this CLI (level ${HOST_API_LEVEL})`}. ` +
        `Nothing was sent that changes anything. Use the centre's own CLI: node ${SELF} update. If the owner upgraded this checkout, they rerun the installer so the centre matches it.`,
      3,
    );
  }
  fail(`this CLI is written for API level ${HOST_API_LEVEL}, and the centre at ${centre} speaks level ${level}. Nothing was changed. Replace this CLI with the centre's own: node ${SELF} update, then run the command again.`, 3);
}

const REFUSAL_HINTS = {
  crosses_one_way_change: `Stop and show this to the user. Going back past a one-way change is the owner's decision: signed in as the owner (node ${SELF} login), they run in their own terminal: node ${SELF} undo --accept-one-way "<why>" (with the same --to, if one was given).`,
  plan_changed: "Nothing changed. Run the same undo again to see what going back does now, then confirm that.",
  owner_required: "Stop and show this to the user: it is theirs to do, signed in as the owner. Do not look for a way around it.",
  working_copy_behind: `Run node ${SELF} fetch, then make the change again.`,
  unauthenticated: `The centre did not accept the credential. A token lives in ${STATE_DIR}/${CENTRE_FILE} (or APPGOV_TOKEN); the owner creates one with token create. Ask the user.`,
};
const refusalCode = (reason) => (reason === "crosses_one_way_change" || reason === "owner_required" ? 2 : 3);
const refusalText = (data, fallback) => `${data.error ?? fallback}${REFUSAL_HINTS[data.reason] ? `\n${REFUSAL_HINTS[data.reason]}` : ""}`;

async function send(method, path, payload, { owner = false } = {}) {
  if (!CENTRE) fail(`no centre to talk to: there is no --host flag, no APPGOV_HOST, and no ${STATE_DIR}/${CENTRE_FILE} here or above. Ask the user for the centre's address and a token.`, 3);
  let url;
  try {
    url = new URL(`${CENTRE}${path}`);
  } catch {}
  if (url?.protocol !== "https:" && url?.protocol !== "http:") fail(`the centre's address must be an https:// address, not "${CENTRE}". ${CENTRE_SOURCE}`, 3);
  const secret = credential(owner, method);
  if (!secret) {
    if (owner) fail(`no owner session for the centre at ${CENTRE}: sign in first, in your terminal, with node ${SELF} login.`, 2);
    fail(
      method === "GET"
        ? `no credential for the centre at ${CENTRE}: no APPGOV_TOKEN, no token in ${STATE_DIR}/${CENTRE_FILE}, and no owner session. Ask the user for a token.`
        : `no token for the centre at ${CENTRE}: no APPGOV_TOKEN and no token in ${STATE_DIR}/${CENTRE_FILE}, so nothing was sent. Ask the user for a token. (The owner acts as themselves with --owner, in a terminal.)`,
      3,
    );
  }
  const began = Date.now();
  const { err, connected, status, level, timing, host, text } = await request(method, url, payload, secret);
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
  checkLevel(level, url);
  noteMoved(host);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text.slice(0, 300) };
  }
  if (flags.timing) printTiming(`${method} ${path}`, Date.now() - began, data?.timing, timing);
  return { status, data };
}

/**
 * The centre says where it lives (x-appgov-host): once it has the owner's domain, the address this CLI came by
 * (workers.dev) still answers, and this says once, on stderr, how to move to the new one.
 */
let movedSaid = false;
/** The centre's own address, as its last answer gave it. */
let centreSays = null;
function noteMoved(host) {
  if (typeof host === "string" && host) centreSays = clean(host);
  if (movedSaid || typeof host !== "string" || !host || clean(host) === CENTRE || command === "update") return;
  movedSaid = true;
  const where = CENTRE_RECORD && clean(CENTRE_RECORD.url) === CENTRE ? `node ${SELF} update moves ${CENTRE_RECORD.file} to it` : `use --host ${clean(host)}`;
  console.error(`note: this centre's address is now ${clean(host)}; ${CENTRE} still answers. ${where}.`);
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

/**
 * Where an operation's time went, on stderr (so --json stays one document): the centre's steps (starting the
 * container, loading and saving the record), the Host's steps as it marked them, nested, and what is left for the
 * network and the Worker. A step with inner steps also shows the time none of them account for.
 */
function printTiming(what, wall, timing, header) {
  const lines = [`timing: ${what} took ${wall} ms at this CLI`];
  const row = (depth, name, ms) => lines.push(`${"  ".repeat(depth + 1)}${name.padEnd(58 - depth * 2)} ${String(ms).padStart(6)} ms`);
  const centre = timing?.centre ?? Object.fromEntries(String(header ?? "").split(";").filter(Boolean).map((kv) => kv.split("=")).map(([k, v]) => [k, Number(v)]));
  const steps = Array.isArray(timing?.steps) ? timing.steps : [];
  if (centre.view !== undefined && centre.save === undefined) row(0, { stored: "read the stored view from R2 (no container)", legacy: "read through the app's Durable Object, still on the build before" }[timing?.view] ?? "the container computed the view, the centre stored it", centre.view);
  if (centre.container !== undefined) row(0, "start the Host's container (0 when it runs)", centre.container);
  if (centre.load !== undefined) row(0, "load the record from R2 into the container", centre.load);
  if (centre.op !== undefined) row(0, "the Host's operation, as the centre waited for it", centre.op);
  // Steps nest by depth; when a step with inner steps closes, the time they do not account for is shown under it.
  const open = [];
  const close = (depth) => {
    while (open.length && open.at(-1).step.depth >= depth) {
      const { step, inner, children } = open.pop();
      if (children && step.ms - inner > 0) row(step.depth + 2, `(rest of: ${step.step})`, step.ms - inner);
    }
  };
  for (const step of steps) {
    close(step.depth);
    const parent = open.at(-1);
    if (parent) {
      parent.inner += step.ms;
      parent.children = true;
    }
    row(step.depth + 1, step.step, step.ms);
    open.push({ step, inner: 0, children: false });
  }
  close(0);
  if (typeof timing?.host_ms === "number") {
    // Steps that ran at the same time count once: the time covered by at least one of the Host's own steps.
    let covered = 0;
    let end = -Infinity;
    for (const s of steps.filter((s) => s.depth === 0).sort((a, b) => a.at_ms - b.at_ms)) {
      covered += Math.max(0, s.at_ms + s.ms - Math.max(s.at_ms, end));
      end = Math.max(end, s.at_ms + s.ms);
    }
    row(1, "(the Host's other work: open, classify, decide, write files)", Math.max(0, timing.host_ms - covered));
  }
  if (centre.save !== undefined) row(0, "save the record to R2", centre.save);
  if (centre.view !== undefined && centre.save !== undefined) row(0, "compute the app's view in the container and store it in R2", centre.view);
  const known = (centre.container ?? 0) + (centre.load ?? 0) + (centre.op ?? 0) + (centre.save ?? 0) + (centre.view ?? 0);
  if (known) row(0, "(the network, the Worker and the Durable Object)", wall - known);
  console.error(lines.join("\n"));
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
  return `preview: none standing; ${preview.note}. Publish it again with: node ${SELF} preview ${changeId}`;
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
    const look = result.preview ? "They can open the preview, then decide, signed in as the owner, in their own terminal, with" : "They decide, signed in as the owner, in their own terminal, with";
    console.log(`Show this to the owner. ${look}: node ${SELF} approve ${result.change_id}   (or deny)`);
    return 2;
  }
  console.log(`rejected (${result.reason}): nothing was released.`);
  if (result.detail) console.log(result.detail);
  if (REJECTION_HINTS[result.reason]) console.log(REJECTION_HINTS[result.reason]);
  return 1;
}

/**
 * How the centre moved on from the version a working copy holds, by the centre's history: the versions it went back
 * past (newest first) and the versions it released since (oldest first), to where both lines of versions meet. Null
 * for both when they do not meet.
 */
function versionsBetween(history, held, centre) {
  const builtOn = (version) => items(history).find((entry) => entry?.version === version && entry.kind !== "restore")?.base_version ?? null;
  const line = (version) => {
    const out = [];
    for (let at = version; at && !out.includes(at); at = builtOn(at)) out.push(at);
    return out;
  };
  const centreLine = line(centre);
  const heldLine = line(held);
  const meet = centreLine.find((version) => heldLine.includes(version));
  if (!meet) return { went_back_past: null, released: null };
  return { went_back_past: heldLine.slice(0, heldLine.indexOf(meet)), released: centreLine.slice(0, centreLine.indexOf(meet)).reverse() };
}

/** The line status prints for a working copy that is behind the centre: which versions, and how far. */
function behindLine({ holds, centre, went_back_past: back, released }) {
  const start = `this working copy is behind the centre: it holds ${holds}, and the centre is on ${centre}.`;
  const end = "Run fetch before changing anything.";
  if (!back || !released) return `${start} ${end}`;
  const moves = [
    back.length ? `went back past ${back.join(", ")}` : "",
    released.length ? `released ${released.join(", ")}${back.length ? "" : ` (${released.length} version${released.length === 1 ? "" : "s"} behind)`}` : "",
  ].filter(Boolean);
  return `${start} Since this copy was last brought up to date, the centre ${moves.join(" and then ")}. ${end}`;
}

const OWNER_VERB = (verb) => `node ${SELF} ${verb}`;

/**
 * What status and list say first when an app is not running: what PneumaSpace said about it and when, what the centre
 * knows, and what the owner can do. None while it runs. A centre from before these fields sends none.
 */
function standingLines(s) {
  const when = s.runtime?.checked_at ? ` (PneumaSpace, ${readableTime(s.runtime.checked_at)})` : "";
  const name = s.app_id;
  if (s.standing === "down") {
    const down = s.taken_down ?? {};
    if (s.runtime?.state === "serving") return [`TAKEN DOWN here by ${down.by ?? "the owner"}, but PneumaSpace serves it again${when}. The owner records it as back (${OWNER_VERB("bring-back")}) or takes it down again.`];
    const gone = s.runtime?.state === "gone";
    return [
      `TAKEN DOWN: ${down.by ?? "the owner"} took ${name} down${down.at ? ` ${readableTime(down.at)}` : ""}. It serves nothing and takes no changes; ${gone ? "PneumaSpace no longer has it, so the data it stored there is gone" : "PneumaSpace keeps its stored data"}${when}.`,
      gone ? `The owner publishes it again (${OWNER_VERB("publish-again")}) or clears it (${OWNER_VERB("clear")}).` : `The owner brings it back (${OWNER_VERB("bring-back")}) or clears it (${OWNER_VERB("clear")}).`,
    ];
  }
  if (s.standing === "removed_elsewhere") {
    return [
      `TAKEN DOWN ON PNEUMASPACE, not through this centre: ${name} serves nothing, and PneumaSpace keeps its stored data${when}. Changes are refused.`,
      `The owner brings it back (${OWNER_VERB("bring-back")}) or clears it (${OWNER_VERB("clear")}).`,
    ];
  }
  if (s.standing === "vanished") {
    return [
      `NOT ON PNEUMASPACE: it has no app named ${name} any more, and this centre did not take it down, so the data it stored there is gone${when}. Changes are refused.`,
      `The owner publishes it again from ${s.active_version ?? "its current version"}, with no stored data (${OWNER_VERB("publish-again")}), or clears it (${OWNER_VERB("clear")}).`,
    ];
  }
  if (s.standing === "unconfirmed") return [`PneumaSpace did not answer, so whether ${name} is there is not confirmed${s.runtime?.note ? ` (${s.runtime.note})` : ""}.`];
  return [];
}
const serves = (s) => !s.standing || s.standing === "running" || s.standing === "unconfirmed" || (s.standing === "down" && s.runtime?.state === "serving");
/** PneumaSpace stops an idle app's container and starts it on the next request; an agent seeing it asleep should not keep it awake. */
const ASLEEP_IS_NORMAL =
  "asleep is normal: PneumaSpace stops the app's container after a few minutes without requests and starts it, with its data, on the next request, in a few seconds; nothing needs to keep it awake, and an app kept awake holds one of the few apps the deployment runs at once";
/** When PneumaSpace last confirmed what is said about it, where the centre answers from stored facts. */
const checkedLine = (at, failed) =>
  `${at ? `PneumaSpace confirmed this ${readableTime(at)}` : "PneumaSpace has not been asked about these yet"}${failed ? `; asking it again just now failed (${failed})` : ""}. --check asks it now.`;

function printApps({ governance, apps, runtime_check }) {
  if (!apps.length) return console.log(`no apps yet. Create one with: node ${SELF} create <name>`);
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
    console.log(`${String(app.app_id).padEnd(width)}  ${app.active_version ?? "unpublished"}  ${serves(app) ? app.address : "not serving"}`);
    for (const line of standingLines(app)) console.log(`  ${line}`);
    const last = app.last_change;
    if (last) console.log(`  last change ${readableTime(last.at)} by ${clip(last.agent, 40)}: "${clip(last.intent)}" (${last.kind} ${last.outcome}${last.version ? ` ${last.version}` : ""})`);
    for (const p of items(app.pending)) console.log(`  waiting for the owner: ${p.change_id} "${clip(p.intent)}" (${items(p.risks).join(", ")})`);
    if (app.serving_uncertain) console.log(`  the Host cannot vouch for what the address serves: ${app.serving_uncertain}`);
    else if (app.serves_other_version) console.log(`  the address serves ${app.serving_version}, not ${app.active_version}: the last release did not go live`);
  }
  // The oldest claim on the list about PneumaSpace: each app's is as new as its last write or the last listing.
  const oldest = apps.map((app) => app.runtime?.checked_at).filter((at) => typeof at === "string").sort()[0];
  if (runtime_check) console.log(`\n${checkedLine(oldest, runtime_check.failed)}`);
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
  // The centre's own address always (as it gave it, whatever address this command came by); the agent token when this
  // command had one (signed in as the owner, it has none).
  writePrivate(join(dir, STATE_DIR, CENTRE_FILE), { url: centreSays ?? CENTRE, ...(TOKEN ? { token: TOKEN } : {}) });
  console.log(`working copy of ${copy.app} (${copy.active_version}) in ${dir}; the centre's address${TOKEN ? " and the token are" : " is"} in ${join(dir, STATE_DIR, CENTRE_FILE)} (keep it out of git). Open it with your coding agent.`);
}

// The block this CLI keeps in a directory's AGENTS.md, as the local edition's Host keeps the one in its apps directory.
const BLOCK_BEGIN = "<!-- appgov-centre:begin (written by token create and update; edits inside it are lost) -->";
const BLOCK_END = "<!-- appgov-centre:end -->";

/** Put `block` into the AGENTS.md text `existing`, replacing an earlier copy of it and keeping the rest. */
function withBlock(existing, block) {
  const wrapped = `${BLOCK_BEGIN}\n${block.trim()}\n${BLOCK_END}\n`;
  const begin = existing.indexOf(BLOCK_BEGIN);
  const end = begin === -1 ? -1 : existing.indexOf(BLOCK_END, begin);
  if (end !== -1) return `${existing.slice(0, begin)}${wrapped}${existing.slice(end + BLOCK_END.length).replace(/^\n/, "")}`;
  return existing.trim() ? `${wrapped}\n${existing.trimStart()}` : wrapped;
}

/**
 * Make `dir` explain itself to an agent started there: the centre's own CLI at .appgov/appgov.mjs, and an AGENTS.md
 * block saying what the directory is, the commands, and that .appgov/centre.json is a credential (Claude Code reads it
 * through a CLAUDE.md holding @AGENTS.md). Text outside the block and an existing CLAUDE.md are left alone.
 */
function writeStarter(dir, starter) {
  if (typeof starter?.cli !== "string" || typeof starter?.agents !== "string") fail("the centre did not send its CLI and the starter instructions", 3);
  const written = [];
  const cli = join(dir, STATE_DIR, "appgov.mjs");
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, starter.cli, { mode: 0o755 });
  written.push(`${STATE_DIR}/appgov.mjs`);
  const agents = join(dir, "AGENTS.md");
  const existing = existsSync(agents) ? readFileSync(agents, "utf8") : "";
  const wanted = withBlock(existing, starter.agents);
  if (wanted !== existing) {
    writeFileSync(agents, wanted);
    written.push("AGENTS.md");
  }
  const claude = join(dir, "CLAUDE.md");
  if (!existsSync(claude)) {
    writeFileSync(claude, "@AGENTS.md\n");
    written.push("CLAUDE.md");
  }
  return written;
}

// --- commands that need no app ----------------------------------------------------------------------------

if (command === "update") {
  // Any credential will do; the API level is not checked here (checkLevel), since this is how a CLI catches up.
  const self = fileURLToPath(import.meta.url);
  // Only a copy in a directory's .appgov/ is replaced; the repository's own CLI is the owner's, and the installer deploys it.
  if (dirname(self).split(sep).at(-1) !== STATE_DIR) fail(`update replaces a copy of the CLI at ${STATE_DIR}/appgov.mjs; this one is ${self}. To bring the centre to this CLI's level, the owner reruns the installer.`);
  const starter = await call("GET", "/starter");
  // The centre's own address, when it lives at another one than this directory's centre.json says (the owner gave the
  // Host a domain): the token stays, the address is the centre's.
  const home = typeof starter.host_url === "string" && starter.host_url ? clean(starter.host_url) : null;
  if (home && CENTRE_RECORD && clean(CENTRE_RECORD.url) === CENTRE && CENTRE !== home) {
    const { file, ...record } = CENTRE_RECORD;
    writePrivate(file, { ...record, url: home });
    console.log(`moved ${file} from ${CENTRE} to the centre's address, ${home}.`);
  }
  const same = readFileSync(self, "utf8") === starter.cli;
  if (!same) writeFileSync(self, starter.cli);
  console.log(same ? `${SELF} is the centre's own CLI already (API level ${starter.api_level}).` : `replaced ${SELF} with the centre's own CLI (API level ${starter.api_level}). Run your command again.`);
  process.exit(0);
}

if (command === "connect") {
  // The agent's side of connecting from the owner page (worker/connect.ts): the one-time code is traded for an agent
  // token, which goes straight into .appgov/centre.json and is never printed; then this centre's CLI and starter
  // instructions go beside it, as token create --write leaves them.
  const code = args[0];
  if (!code) fail(`connect takes the one-time code the owner page shows: curl -fsS <the Host's address>/connect | node - <code>`);
  if (!CENTRE) fail("connect needs the Host's address (--host <url>), as in the command the owner page shows");
  const dir = resolve(flags.into ?? ".");
  const file = join(dir, STATE_DIR, CENTRE_FILE);
  if (existsSync(file)) fail(`${file} exists already, so ${dir} is connected. Nothing was changed.`);
  const at = new URL(`${CENTRE}/connect`);
  const traded = await request("POST", at, { code, agent: identifyAgent().name });
  if (traded.err) fail(`cannot reach the Host at ${CENTRE} (${traded.err.code ?? traded.err.message}). If a sandbox blocks the network, run this with network access (ask the user). Nothing was changed.`, 3);
  checkLevel(traded.level, at);
  let data = {};
  try {
    data = JSON.parse(traded.text);
  } catch {}
  if (traded.status !== 201 || typeof data.token !== "string") {
    fail(`${data.error ?? `the Host answered ${traded.status}`}${data.reason === "bad_code" || data.reason === "too_many_attempts" ? "\nAsk the user for a new code: they make one on the owner page, under \"Connect my AI assistant\"." : ""} Nothing was changed.`, 3);
  }
  const home = typeof data.host_url === "string" && data.host_url ? clean(data.host_url) : CENTRE;
  const starter = await request("GET", new URL(`${home}/starter`), undefined, data.token);
  let found = null;
  try {
    found = starter.status === 200 ? JSON.parse(starter.text) : null;
  } catch {}
  if (typeof found?.cli !== "string" || typeof found?.agents !== "string") {
    fail(`the Host made the token but did not send its CLI and instructions (${starter.err?.code ?? starter.status}); nothing was written. Ask the user to revoke "${data.label}" on the owner page and make a new code.`, 3);
  }
  writePrivate(file, { url: home, token: data.token });
  const written = writeStarter(dir, found);
  console.log(`connected ${dir} to the Host at ${home} as "${data.label}". The token is in ${join(STATE_DIR, CENTRE_FILE)}: never print it, copy it or commit it.`);
  console.log(`written: ${[join(STATE_DIR, CENTRE_FILE), ...written].join(", ")}. Read AGENTS.md here: it says what this directory is and how to create, change and list apps.`);
  process.exit(0);
}

if (command === "login") {
  // The session it keeps is what lets a command act as the owner; making one is a person's act, as using it is.
  if (!TERMINAL) fail(`login is the owner's to do, by a person in a terminal; this command has none, so nothing was sent. ${NOT_FOR_AGENTS}`, 2);
  const files = ownerFiles();
  if (!files) fail(`no owner credentials file for ${CENTRE ?? "this centre"} in ${join(appgovHome(), "hosts")}; the installer wrote it there. Pass --key-file <file>.`);
  const record = readJson(files.keyFile);
  if (!record?.key || !record?.url) fail(`${files.keyFile} is not an owner credentials file`);
  const url = clean(record.url);
  const { err, status, level, text } = await request("POST", new URL(`${url}/auth/login`), { key: record.key });
  if (err) fail(`cannot reach the centre at ${url} (${err.code ?? err.message})`, 3);
  checkLevel(level, new URL(url));
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
  if (!ownerSession()) fail(`tokens are the owner's: sign in first with node ${SELF} login`, 2);
  if (sub === "list") {
    out(await call("GET", "/tokens", undefined, { owner: true }), ({ tokens }) => {
      if (!tokens.length) console.log("no tokens");
      for (const t of tokens) console.log(`${t.id}  ${t.label}  created ${readableTime(new Date(t.created_at).toISOString())}  ${t.revoked_at ? "revoked" : `valid until ${readableTime(new Date(t.expires_at).toISOString())}`}`);
    });
    process.exit(0);
  }
  if (sub === "revoke") {
    if (!id) fail("token revoke takes <id>");
    await confirmAsOwner("revoke", `Revoking token ${id}`);
    out(await call("DELETE", `/tokens/${encodeURIComponent(id)}`, undefined, { owner: true }), () => console.log(`revoked ${id}`));
    process.exit(0);
  }
  if (sub === "create") {
    // Never printed: the token goes straight into the file the agent's CLI reads.
    if (!flags.write) fail("token create writes the token to <dir>/.appgov/centre.json and never prints it: pass --write <dir>");
    const dir = resolve(flags.write);
    const file = join(dir, STATE_DIR, CENTRE_FILE);
    if (existsSync(file)) fail(`${file} exists already; revoke the token in it first, or write to another directory`);
    await confirmAsOwner("create", `Creating a token for ${dir}`);
    // What the agent will run and read comes from the centre, before any token exists: nothing is left half made.
    const starter = await call("GET", "/starter", undefined, { owner: true });
    const data = await call("POST", "/tokens", { label: flags.label ?? "agent", ...(flags.days ? { expires_in_days: Number(flags.days) } : {}) }, { owner: true });
    // The centre's own address, whatever address this command came by.
    writePrivate(file, { url: typeof starter.host_url === "string" && starter.host_url ? clean(starter.host_url) : CENTRE, token: data.token });
    const written = writeStarter(dir, starter);
    console.log(`created token ${data.id} (${data.label}), valid until ${readableTime(new Date(data.expires_at).toISOString())}; written to ${file}. Keep that file out of git.`);
    console.log(`${dir} also has ${written.join(", ")}: this centre's CLI and what an agent started there needs to know. Start your agent in ${dir}.`);
    process.exit(0);
  }
  fail("token takes create, list or revoke");
}

if (command === "list") {
  out(await call("GET", `/apps${flags.check ? "?check=1" : ""}`), printApps);
  process.exit(0);
}

if (command === "create") {
  if (!args[0]) fail("create takes <name>");
  const dir = resolve(flags.into ?? args[0]);
  if (existsSync(dir) && readdirSync(dir).length) fail(`${dir} is not empty; name another directory with --into <dir>`);
  if (flags.owner) await confirmAsOwner("create", `Creating ${args[0]} as the owner`);
  // The centre records who asked from the credential: with an agent token, as the agent named or detected here.
  const result = await call("POST", "/apps", { name: args[0], ...agentFields(identifyAgent()) }, { owner: Boolean(flags.owner) });
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
// take-down, bring-back, publish-again and clear take the app's name as a word too, outside a working copy (or its own
// name inside one): any other words are the owner's reason.
const LIFECYCLE = ["take-down", "bring-back", "publish-again", "clear"];
const lifeNamed = LIFECYCLE.includes(command) && /^[a-z][a-z0-9-]{0,29}$/.test(words[0] ?? "") && (!COPY || words[0] === COPY.app);
const named = ((command === "status" || command === "history" || command === "container") && words[0]) || lifeNamed ? words[0] : undefined;
const app = flags.app ?? named ?? COPY?.app;
if (!app) fail(`not inside a working copy (no ${STATE_DIR}/app.json here or above). Name the app with --app <name> (status and history also take it as a word); list shows every app.`);
const base = `/apps/${app}`;
// The working copy, when this command runs in the app's own.
const DIR = COPY?.app === app ? COPY.dir : null;
const synced = DIR ? readJson(join(DIR, STATE_DIR, SYNCED_FILE)) : null;
const baseVersion = synced?.active_version ?? undefined;

switch (command) {
  case "status": {
    const s = await call("GET", `${base}${flags.check ? "?check=1" : ""}`);
    // A working copy last brought in line with another version than the centre's is behind: its files are that
    // version's, so the edits here are what differs from it, not what differs from the centre's version.
    const behind = DIR && baseVersion && s.active_version && baseVersion !== s.active_version ? { holds: baseVersion, centre: s.active_version } : null;
    if (behind) Object.assign(behind, versionsBetween((await call("GET", `${base}/history`)).history, behind.holds, behind.centre));
    const here = DIR ? changedAgainst(DIR, behind ? behind.holds : s.active_version) : null;
    // The edits here may be a change that was submitted and waits for the owner: then they are not still to submit.
    const mine = DIR ? signature(localEntries(DIR)) : null;
    const waitingHere = mine ? s.pending.find((p) => p.tree_signature === mine) : undefined;
    out({ ...s, ...(here ? { uncommitted_here: here } : {}), ...(behind ? { behind } : {}), ...(waitingHere ? { waiting_here: waitingHere.change_id } : {}) }, () => {
      console.log(`${s.app_id}: ${s.active_version ?? "unpublished"} ${serves(s) ? `at ${s.address}` : "(not serving)"}`);
      for (const line of standingLines(s)) console.log(line);
      if (s.runtime) console.log(checkedLine(s.runtime.checked_at, s.runtime_check_failed));
      if (s.standing === "running") console.log(ASLEEP_IS_NORMAL);
      if (s.serving_uncertain) console.log(`the Host cannot vouch for what the address serves: ${s.serving_uncertain}`);
      else if (s.serving_version && s.serving_version !== s.active_version) {
        console.log(`the address serves ${s.serving_version}, not ${s.active_version}: the last release did not go live. Submitting with no new edits releases ${s.active_version} as it is.`);
      }
      console.log(`previous: ${s.previous_version ? `${s.previous_version} (undo goes back here)` : "none (this is the first version)"}; owner: ${s.owner}; governance: ${s.governance}`);
      console.log(s.governance_note);
      console.log(`on PneumaSpace: ${s.space_manager.note}`);
      if (DIR) {
        if (behind) console.log(behindLine(behind));
        if (waitingHere) {
          console.log(`changed here: ${here?.length ? here.join(", ") : "the files of the change below"}. These edits are change ${waitingHere.change_id}, which was submitted and waits for the owner. Do not submit them again; the owner approves or denies it.`);
        } else {
          const notes = [
            behind ? (here?.length ? `edited here on ${behind.holds}, the version this copy holds, so fetch refuses while they are here` : `the files here are ${behind.holds}'s, the version this copy holds`) : "",
            s.pending.length && here?.length ? "they are not the change waiting for the owner as it was submitted" : "",
          ].filter(Boolean);
          const note = notes.length ? ` (${notes.join("; ")})` : "";
          console.log(`changed here, not submitted: ${here === null ? "unknown (this working copy does not hold the files of the version it was brought up to; run fetch)" : `${here.length ? here.join(", ") : "none"}${note}`}`);
        }
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
        console.log(`${h.at} ${h.kind} ${h.outcome}${where} by ${h.agent}${h.credential ? ` (${String(h.credential).replace(/^agent token /, "token ")})` : ""} [${h.control}]: ${h.intent}${why}`);
        if (h.author) console.log(`    the change was made by ${h.author}`);
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
    if (agent.source === "ambiguous" && !flags.owner) console.error('appgov: warning: markers of more than one agent are set, so this is recorded as agent "unknown". Say which agent you are with --agent <name> or APPGOV_AGENT=<name>.');
    if (flags.owner) await confirmAsOwner("submit", "Submitting as the owner");
    const entries = localEntries(DIR);
    const uploaded = signature(entries);
    const result = await call(
      "POST",
      `${base}/changes`,
      {
        intent: args.join(" "),
        ...agentFields(agent),
        ...(flags.oneWay !== undefined ? { one_way: flags.oneWay } : {}),
        ...(baseVersion ? { base_version: baseVersion } : {}),
        tree: { files: entries.map(([path, body]) => ({ path, body: body.toString("base64") })) },
      },
      { owner: Boolean(flags.owner) },
    );
    sync(DIR, result, uploaded);
    let code = result.status === "published" ? 0 : result.status === "needs_approval" ? 2 : 1;
    out(result, (data) => (code = printChange(data)));
    process.exit(code);
  }
  case "discard": {
    // No base check: putting the centre's working tree back to its active version loses nothing that was released.
    if (flags.owner) await confirmAsOwner("discard", "Discarding as the owner");
    const data = await call("POST", `${base}/discard`, {}, { owner: Boolean(flags.owner) });
    // Discarding throws away the edits here too: that is what was asked for.
    if (DIR) writePrivate(join(DIR, STATE_DIR, SYNCED_FILE), { ...(synced ?? {}), signature: signature(localEntries(DIR)) });
    sync(DIR, data);
    out(data, (d) => console.log(`working tree is back at ${d.active_version}${d.restored.length ? `; restored: ${d.restored.join(", ")}` : ""}`));
    break;
  }
  case "undo": {
    // Confirming a one-way crossing is the owner's alone, and an undo the owner wants recorded as theirs says --owner:
    // both go with the owner's session, from a terminal. Any other undo goes with the agent token, as the agent's.
    const owner = Boolean(flags.owner || flags.acceptOneWay);
    if (owner) await confirmAsOwner("undo", flags.acceptOneWay ? "Going back past a one-way change" : "Going back as the owner");
    const actor = owner ? { name: "owner" } : identifyAgent();
    const payload = { reason: args.join(" ") || "undo", actor: actor.name, ...(flags.to ? { to: flags.to } : {}), ...(baseVersion ? { base_version: baseVersion } : {}) };
    let { status, data } = await send("POST", `${base}/undo`, payload, { owner });
    if (flags.acceptOneWay && status === 409 && data.reason === "crosses_one_way_change") {
      console.log(data.error);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question('Type "accept" to go back with the code only, leaving the stored data as it is: ').catch(() => "");
      rl.close();
      if (answer.trim() !== "accept") fail("not confirmed; nothing changed");
      // The confirmation covers the plan just shown: the Host refuses it once the app has moved on from where that plan started.
      ({ status, data } = await send("POST", `${base}/undo`, { ...payload, accept_one_way: true, ...(data.from ? { from: data.from } : {}) }, { owner: true }));
    }
    if (status < 200 || status >= 300) fail(refusalText(data, `POST ${base}/undo answered ${status}`), refusalCode(data.reason));
    sync(DIR, data);
    out(data, (d) => {
      console.log(`now on ${d.active_version} (was ${d.undone_version}) at ${d.address}.${d.undone.length > 1 ? ` Went back past ${d.undone.join(", ")}.` : ""}`);
      if (d.confirmed_by) console.log(`Code only; stored data was not put back, as ${d.confirmed_by} confirmed. This version may fail on it.`);
      else console.log("Code only; stored data was not rolled back.");
      if (d.data_left) console.log(d.data_left);
      // What the submitter said it did to stored data, which the Host's rules could not see.
      for (const declared of items(d.declared_one_way)) console.log(`${declared.version} was declared one-way when it was submitted: "${declared.reason}". Going back put back its code, not what it did to stored data.`);
      if (d.note) console.log(d.note);
    });
    break;
  }
  case "take-down":
  case "bring-back":
  case "publish-again":
  case "clear": {
    // The owner's, by a person: refused here without a terminal or a session, before anything is sent. The centre
    // refuses an agent token on its own as well.
    const what = { "take-down": `Taking ${app} down`, "bring-back": `Bringing ${app} back`, "publish-again": `Publishing ${app} again`, clear: `Clearing ${app}` }[command];
    if (!TERMINAL) fail(`${what} is the owner's to do, by a person in a terminal; this command has none, so nothing was sent. ${NOT_FOR_AGENTS}`, 2);
    if (!ownerSession()) fail(`${what} is the owner's to do: sign in first, in your terminal, with node ${SELF} login. Nothing was sent.`, 2);
    const s = await call("GET", `${base}?check=1`, undefined, { owner: true });
    for (const line of standingLines(s)) console.log(line);
    const said = {
      "take-down": [`${what}: it stops serving. PneumaSpace keeps it removed, with its stored data, and the centre keeps its record and history. Agents' submits are refused until you bring it back.`],
      "bring-back": [`${what}: it serves ${s.active_version} again, with the data PneumaSpace kept.`],
      "publish-again": [`${what}: PneumaSpace creates it anew from ${s.active_version}. The data it stored there before is not there any more: it starts with none.`],
      clear: [`${what}. This deletes:`, ...items(s.clearing?.deletes).map((line) => `  - ${line}`), "This stays:", ...items(s.clearing?.keeps).map((line) => `  - ${line}`)],
    }[command];
    for (const line of said) console.log(line);
    // Clearing asks for the app's name, as the page does; the others for the command's own word.
    await confirmAsOwner(command === "clear" ? app : command, what);
    const reason = words.slice(named ? 1 : 0).join(" ");
    const result = await call("POST", `${base}/${command}`, { ...(command === "clear" ? { confirm: app } : {}), ...(reason ? { reason } : {}) }, { owner: true });
    out(result, (d) => {
      if (command !== "clear") return console.log(d.note);
      console.log(`cleared: the centre no longer has ${app}.`);
      for (const line of items(d.kept)) console.log(`still there: ${line}`);
      if (d.space_holds) console.log(`To finish, purge ${app} in PneumaSpace's console, as its owner: until then its name, its app slot and its storage stay taken there.`);
    });
    break;
  }
  case "approve":
  case "deny": {
    if (!args[0]) fail(`${command} takes <change-id>`);
    // The owner's decision, by a person: refused here without a terminal or a session, before anything is sent. The
    // centre refuses an agent token on its own as well.
    const what = command === "approve" ? `Approving change ${args[0]}` : `Denying change ${args[0]}`;
    if (!TERMINAL) fail(`${what} is the owner's to do, by a person in a terminal; this command has none, so nothing was sent. ${NOT_FOR_AGENTS}`, 2);
    if (!ownerSession()) fail(`${what} is the owner's to do: sign in first, in your terminal, with node ${SELF} login. Nothing was sent.`, 2);
    const status = await call("GET", base, undefined, { owner: true });
    const pending = status.pending.find((p) => p.change_id === args[0]);
    if (!pending) fail(`no change ${args[0]} is waiting`);
    console.log(`"${pending.intent}" by ${pending.agent}\nfiles: ${pending.changed_paths.join(", ")}\nrisks: ${pending.risks.join(", ")}`);
    for (const line of pending.disclosure) console.log(`  - ${line}`);
    if (pending.tests) console.log(`tests: ${pending.tests.note}`);
    if (pending.test_warning) console.log(pending.test_warning);
    if (pending.preview) console.log(previewLine(pending.preview, args[0]));
    await confirmAsOwner(command, what);
    const result = await call("POST", `${base}/changes/${args[0]}/${command}`, { reason: args.slice(1).join(" ") || undefined }, { owner: true });
    sync(DIR, result);
    let code = 0;
    out(result, (data) => (code = command === "deny" ? (console.log("denied; nothing was released"), 0) : printChange(data)));
    process.exit(code);
  }
  case "preview":
    if (!args[0]) fail("preview takes <change-id>");
    if (flags.owner) await confirmAsOwner("preview", "Publishing the preview again as the owner");
    out(await call("POST", `${base}/changes/${args[0]}/preview`, {}, { owner: Boolean(flags.owner) }), (d) => {
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
    if (stop) await confirmAsOwner("stop", `Stopping the Host's container of ${app}`);
    out(await call(stop ? "POST" : "GET", `${base}/container${stop ? "/stop" : ""}`, stop ? {} : undefined, { owner: true }), (d) =>
      console.log(
        stop
          ? `${d.stopped ? `stopped the Host's container of ${app}` : `the Host's container of ${app} was not running`}${d.restarting ? "; its Durable Object restarts, and the next command starts the Host from the build deployed now" : ""}`
          : `the Host's container of ${app} is ${d.running ? "running" : "not running"}${d.image ? `; image ${d.image}` : ""}${d.build ? `; Host build ${d.build}` : ""}${d.worker ? `; Worker version ${d.worker.version} (uploaded ${d.worker.uploaded})` : ""}`,
      ),
    );
    break;
  }
  default:
    fail(`unknown command "${command}"\n${USAGE}`);
}
