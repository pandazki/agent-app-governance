import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { FRAMEWORK_DIR, restoreWorkingTree, sourceFiles, STATE_DIR } from "../../host/src/artifact";

// ---------------------------------------------------------------------------
// The app's folder on its way in and out of the container.
//
// The centre keeps each app's whole folder (source, .pneuma-framework/,
// .appgov/) in R2 as one tar object. The container's disk is a cache: the
// Durable Object loads the tar before an operation and saves it back after
// one that wrote. Here are the two ends of that, plus the folder as a working
// copy sees it: the files the CLI mirrors on the person's machine.
// ---------------------------------------------------------------------------

function run(cmd: string, args: readonly string[], input?: Uint8Array): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
    child.on("error", (e) => resolve({ code: 127, stdout: Buffer.alloc(0), stderr: e.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: err }));
    child.stdin.end(input ? Buffer.from(input) : undefined);
  });
}

/** The folder as one tar, or null when there is no folder. Installed dependencies are left out; nothing else is. */
export async function packFolder(dir: string): Promise<Uint8Array | null> {
  if (!existsSync(dir)) return null;
  const result = await run("tar", ["-c", "-f", "-", "--exclude=./node_modules", "-C", dir, "."]);
  if (result.code !== 0) throw new Error(`tar -c failed: ${result.stderr.slice(0, 400)}`);
  return new Uint8Array(result.stdout);
}

/** Make `dir` hold exactly what the tar holds: whatever was there before is removed first. */
export async function unpackFolder(dir: string, tar: Uint8Array): Promise<void> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const result = await run("tar", ["-x", "-f", "-", "-C", dir, "--no-same-owner"], tar);
  if (result.code !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`tar -x failed: ${result.stderr.slice(0, 400)}`);
  }
}

/** One file of a working copy, base64. */
export interface TreeFile {
  readonly path: string;
  readonly body: string;
}

/**
 * What a working copy holds of the app's folder: the source (the files that make up a version), the whole
 * `.pneuma-framework/` (every version and the history), and the Host's `.appgov/app.json` and CLI. Not the drafts
 * and waiting changes in `.appgov/`, which only the centre uses.
 */
export interface WorkingCopy {
  readonly app: string;
  readonly active_version: string | null;
  readonly files: readonly TreeFile[];
  /**
   * Set when the request said what the working copy holds (`Held`): what `files` leaves out because the copy has it
   * byte for byte. `source`: the source files are the ones it sent. `versions`: each version directory left out, and
   * where the copy has it: `held` (its own copy of that version) or `tree` (the source files it sent). `signatures`:
   * every version directory here, signed as `dirSignature` signs one, for the copy to check its record against.
   */
  readonly omitted?: { readonly source: boolean; readonly versions: Readonly<Record<string, "held" | "tree">>; readonly signatures: Readonly<Record<string, string>> };
}

/**
 * What a working copy holds already, as its CLI says in a request: the signature of the source files it sent or holds
 * (`copySignature`'s), and of each version directory in its `.pneuma-framework/versions/` (`dirSignature`'s).
 */
export interface Held {
  readonly tree?: string;
  readonly versions?: Readonly<Record<string, string>>;
}

/** `held` from a request body, or undefined when it is not in that shape. */
export function parseHeld(value: unknown): Held | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { tree, versions } = value as { tree?: unknown; versions?: unknown };
  const sig = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{40}$/.test(v);
  const named = typeof versions === "object" && versions !== null && !Array.isArray(versions) ? Object.entries(versions as Record<string, unknown>).filter(([name, v]) => /^v\d+$/.test(name) && sig(v)) : [];
  return { ...(sig(tree) ? { tree } : {}), versions: Object.fromEntries(named) as Record<string, string> };
}

/** SHA-1 over each path and the SHA-1 of its bytes, in path order: `copySignature`'s form, over the files `paths` names. */
function signFiles(root: string, paths: readonly string[]): string {
  const hash = createHash("sha1");
  for (const path of [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) hash.update(`${path}\0${createHash("sha1").update(readFileSync(join(root, path))).digest("hex")}\n`);
  return hash.digest("hex");
}

/** Every file of a version directory, signed: a version holds exactly the source files that were recorded, so it signs as they do. */
export function dirSignature(dir: string): string {
  const paths: string[] = [];
  walkAll(dir, dir, paths);
  return signFiles(dir, paths);
}

function walkAll(root: string, base: string, out: string[]): void {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walkAll(path, base, out);
    else if (entry.isFile()) out.push(relative(base, path).split(sep).join("/"));
  }
}

/**
 * The working copy of the app in `appRoot`. With `held`, what the copy has byte for byte is left out and named in
 * `omitted`: the source files when they are the ones it sent, and each version directory it holds or that is those
 * source files. A version is never changed once recorded, and each one left out is matched by its signature.
 */
export function exportWorkingCopy(appRoot: string, app: string, activeVersion: string | null, held?: Held): WorkingCopy {
  const source = [...sourceFiles(appRoot)];
  const framework: string[] = [];
  walkAll(join(appRoot, FRAMEWORK_DIR), appRoot, framework);
  const state = [`${STATE_DIR}/app.json`, `${STATE_DIR}/appgov.mjs`].filter((rel) => existsSync(join(appRoot, rel)));
  const body = (paths: readonly string[]) => [...paths].sort().map((path) => ({ path, body: readFileSync(join(appRoot, path)).toString("base64") }));
  if (!held) return { app, active_version: activeVersion, files: body([...source, ...framework, ...state]) };
  const sameSource = held.tree !== undefined && held.tree === signFiles(appRoot, source);
  const versionsDir = join(appRoot, FRAMEWORK_DIR, "versions");
  const signatures: Record<string, string> = {};
  const versions: Record<string, "held" | "tree"> = {};
  for (const entry of existsSync(versionsDir) ? readdirSync(versionsDir, { withFileTypes: true }) : []) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const signed = (signatures[entry.name] = dirSignature(join(versionsDir, entry.name)));
    if (held.versions?.[entry.name] === signed) versions[entry.name] = "held";
    else if (held.tree === signed) versions[entry.name] = "tree";
  }
  const left = (path: string) => {
    const version = path.startsWith(`${FRAMEWORK_DIR}/versions/`) ? path.split("/")[2]! : null;
    return version !== null && version in versions;
  };
  return {
    app,
    active_version: activeVersion,
    files: body([...(sameSource ? [] : source), ...framework.filter((path) => !left(path)), ...state]),
    omitted: { source: sameSource, versions, signatures },
  };
}

/** A path a working tree may hold: relative, no dot segments, nothing the Host keeps for itself. */
function cleanPath(path: unknown): string {
  if (typeof path !== "string" || !path || path.length > 400 || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    throw new Error(`not a relative path: ${JSON.stringify(path)}`);
  }
  if (path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`not a clean relative path: ${path}`);
  return path;
}

/** The most a submitted working tree may hold, decoded. */
export const TREE_LIMIT_BYTES = 32 * 1024 * 1024;

/**
 * Make the app's working tree hold exactly the submitted files: those a version is made of are replaced, added or
 * removed; `.pneuma-framework/`, `.appgov/` and everything else a version leaves out stay as they are. A file the
 * submission names under one of those is ignored, as the Host would ignore it.
 */
/**
 * A tree's source files as the CLI signs a working copy (`signature` in bin/appgov.mjs): SHA-1 over each path and the
 * SHA-1 of its bytes, in path order. The CLI compares it with its own working tree, e.g. to tell that the edits there
 * are a change waiting for the owner. Null when `root` is not there.
 */
export function copySignature(root: string): string | null {
  return existsSync(root) ? signFiles(root, sourceFiles(root)) : null;
}

/**
 * Replace the source files in `appRoot` with the submitted tree. A file is sent as `{ path, body }` (base64), or as
 * `{ path, same }`: the same bytes as that path in `base`, the version the working copy is on (which the caller has
 * checked is the app's version), with `same` their SHA-1. The file is taken from that version, and refused when it
 * is not there or its SHA-1 differs.
 */
export function replaceWorkingTree(appRoot: string, files: unknown, base?: string): string[] {
  if (!Array.isArray(files)) throw new Error("tree.files must be a list of { path, body }");
  const staging = mkdtempSync(join(tmpdir(), "appgov-tree-"));
  try {
    let bytes = 0;
    const seen = new Set<string>();
    for (const file of files as { path?: unknown; body?: unknown; same?: unknown }[]) {
      const path = cleanPath(file?.path);
      if (seen.has(path)) throw new Error(`the tree names ${path} twice`);
      seen.add(path);
      let body: Buffer;
      if (file.same !== undefined) {
        if (!base) throw new Error(`${path} is sent as a file of the version the working copy is on, and the request does not say which version that is`);
        const there = join(appRoot, FRAMEWORK_DIR, "versions", base, path);
        if (!existsSync(there)) throw new Error(`${path} is sent as the file ${base} holds, and ${base} holds no such file`);
        body = readFileSync(there);
        if (createHash("sha1").update(body).digest("hex") !== file.same) throw new Error(`${path} is sent as the file ${base} holds, and ${base} holds other bytes`);
      } else if (typeof file.body === "string") body = Buffer.from(file.body, "base64");
      else throw new Error(`${path}: body must be base64 text`);
      bytes += body.length;
      if (bytes > TREE_LIMIT_BYTES) throw new Error(`the tree is larger than ${TREE_LIMIT_BYTES} bytes`);
      const to = join(staging, path);
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, body);
    }
    restoreWorkingTree(staging, appRoot);
    return sourceFiles(appRoot);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Bytes on disk under `dir`, for the log. */
export function folderBytes(dir: string): number {
  const files: string[] = [];
  walkAll(dir, dir, files);
  return files.reduce((sum, rel) => sum + statSync(join(dir, rel)).size, 0);
}
