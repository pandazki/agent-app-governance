import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sourceFiles } from "../../host/src/artifact";

// ---------------------------------------------------------------------------
// What an undo leaves behind in stored data.
//
// Undo puts back an earlier version's code and manifest; stored data stays as
// it is. When the versions gone back past declared other capabilities or ran
// SQL the earlier version does not, the data they wrote is still stored and the
// earlier code may not show it (a column it never reads, a store it no longer
// declares). This finds that, from the versions' files, so the CLI can say it.
// It changes nothing.
// ---------------------------------------------------------------------------

/** Files that may hold SQL, as the preset's destructive-SQL rule reads them. */
const CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|sql)$/;
/** A statement that defines or writes stored data, up to where its text ends. */
const STATEMENT =
  /\b(?:CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX|VIEW|TRIGGER|COLUMN)|INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE\s+[\w"`]+\s+SET|DELETE\s+FROM)\b[^;`'"]*/gi;

/** The SQL statements a version's code holds: keyed with spacing and letter case evened out, as written. */
export function sqlStatements(versionDir: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const path of sourceFiles(versionDir)) {
    if (!CODE_FILE.test(path)) continue;
    for (const match of readFileSync(join(versionDir, path), "utf8").matchAll(STATEMENT)) {
      const written = match[0].replace(/\s+/g, " ").trim();
      found.set(written.toUpperCase(), written);
    }
  }
  return found;
}

/** The capabilities in which PneumaSpace keeps an app's data (as in host/src/policy.ts). */
const STORAGE = ["db", "kv", "files", "object"];

/** What a version's manifest declares about where data is kept: its storage capabilities and their settings. */
function storageDeclared(versionDir: string): string {
  const file = join(versionDir, "pneuma-space.json");
  if (!existsSync(file)) return "";
  try {
    const capabilities = (JSON.parse(readFileSync(file, "utf8")) as { capabilities?: Record<string, unknown> })?.capabilities ?? {};
    return JSON.stringify(STORAGE.filter((kind) => kind in capabilities).map((kind) => [kind, capabilities[kind]]));
  } catch {
    return readFileSync(file, "utf8");
  }
}

const clip = (text: string, max = 80) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * One line for the owner when the versions an undo went back past (`undone`, newest first) declare other storage in
 * the manifest or run SQL that `target` does not; undefined otherwise. `versionDir` gives a version's directory.
 */
export function dataLeftBehind(undone: readonly string[], target: string, versionDir: (version: string) => string): string | undefined {
  const targetStorage = storageDeclared(versionDir(target));
  const targetSql = sqlStatements(versionDir(target));
  const manifestChanged = undone.filter((version) => storageDeclared(versionDir(version)) !== targetStorage);
  const newSql = new Map<string, string>();
  for (const version of undone) for (const [key, written] of sqlStatements(versionDir(version))) if (!targetSql.has(key)) newSql.set(key, written);
  if (!manifestChanged.length && !newSql.size) return undefined;
  const which = [...undone].reverse().join(", ");
  const shown = [...newSql.values()].slice(0, 2).map((statement) => clip(statement));
  const what = [
    manifestChanged.length ? "declared other storage in pneuma-space.json" : "",
    newSql.size ? `ran SQL that ${target} does not (${shown.join("; ")}${newSql.size > 2 ? `; and ${newSql.size - 2} more` : ""})` : "",
  ]
    .filter(Boolean)
    .join(" and ");
  return `Data written by the code of ${which} is still stored, and ${target}'s code may not show it: ${which} ${what}.`;
}
