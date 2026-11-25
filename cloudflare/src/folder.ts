import { spawn } from "node:child_process";
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
}

function walkAll(root: string, base: string, out: string[]): void {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walkAll(path, base, out);
    else if (entry.isFile()) out.push(relative(base, path).split(sep).join("/"));
  }
}

export function exportWorkingCopy(appRoot: string, app: string, activeVersion: string | null): WorkingCopy {
  const paths = [...sourceFiles(appRoot)];
  walkAll(join(appRoot, FRAMEWORK_DIR), appRoot, paths);
  for (const rel of [`${STATE_DIR}/app.json`, `${STATE_DIR}/appgov.mjs`]) if (existsSync(join(appRoot, rel))) paths.push(rel);
  return { app, active_version: activeVersion, files: paths.sort().map((path) => ({ path, body: readFileSync(join(appRoot, path)).toString("base64") })) };
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
export function replaceWorkingTree(appRoot: string, files: unknown): string[] {
  if (!Array.isArray(files)) throw new Error("tree.files must be a list of { path, body }");
  const staging = mkdtempSync(join(tmpdir(), "appgov-tree-"));
  try {
    let bytes = 0;
    const seen = new Set<string>();
    for (const file of files as { path?: unknown; body?: unknown }[]) {
      const path = cleanPath(file?.path);
      if (seen.has(path)) throw new Error(`the tree names ${path} twice`);
      seen.add(path);
      if (typeof file.body !== "string") throw new Error(`${path}: body must be base64 text`);
      const body = Buffer.from(file.body, "base64");
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
