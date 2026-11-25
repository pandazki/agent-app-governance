import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dataLeftBehind } from "../src/data-left";

// What an undo leaves in stored data, read from the versions' files (src/data-left.ts).
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function versions(files: Record<string, Record<string, string>>): (version: string) => string {
  const root = mkdtempSync(join(tmpdir(), "data-left-"));
  roots.push(root);
  for (const [version, tree] of Object.entries(files)) {
    for (const [path, body] of Object.entries(tree)) {
      mkdirSync(dirname(join(root, version, path)), { recursive: true });
      writeFileSync(join(root, version, path), body);
    }
  }
  return (version) => join(root, version);
}

const manifest = (capabilities: Record<string, unknown>) => JSON.stringify({ contract: "pneuma-space.cf/1", runtime: "node", entry: "server.mjs", capabilities });
const server = (...sql: string[]) => sql.map((statement) => `await db.exec(\`${statement}\`);\n`).join("");

describe("what an undo leaves in stored data", () => {
  test("a version that added a column: its data is still stored, and the older code may not show it", () => {
    const dir = versions({
      v3: { "pneuma-space.json": manifest({ db: {} }), "app/server.mjs": server("CREATE TABLE IF NOT EXISTS books (title TEXT)") },
      v4: { "pneuma-space.json": manifest({ db: {} }), "app/server.mjs": server("CREATE TABLE IF NOT EXISTS books (title TEXT)", "ALTER TABLE books ADD COLUMN finished_date TEXT") },
    });
    expect(dataLeftBehind(["v4"], "v3", dir)).toBe(
      "Data written by the code of v4 is still stored, and v3's code may not show it: v4 ran SQL that v3 does not (ALTER TABLE books ADD COLUMN finished_date TEXT).",
    );
  });

  test("versions that declared other storage: named oldest first", () => {
    const dir = versions({
      v1: { "pneuma-space.json": manifest({ kv: {}, identity: { required: true } }) },
      v2: { "pneuma-space.json": manifest({ db: {}, identity: { required: true } }) },
      v3: { "pneuma-space.json": manifest({ db: {}, identity: {} }) },
    });
    expect(dataLeftBehind(["v3", "v2"], "v1", dir)).toBe("Data written by the code of v2, v3 is still stored, and v1's code may not show it: v2, v3 declared other storage in pneuma-space.json.");
  });

  test("nothing to say when the versions gone back past changed neither storage nor SQL", () => {
    const dir = versions({
      v1: { "pneuma-space.json": manifest({ kv: {}, identity: { required: true } }), "app/server.mjs": server("INSERT INTO t VALUES (1)") },
      v2: { "pneuma-space.json": manifest({ kv: {}, identity: {} }), "app/server.mjs": `${server("insert   into t values (1)")}// restyled\n`, "app/public/style.css": "body{}" },
    });
    expect(dataLeftBehind(["v2"], "v1", dir)).toBeUndefined();
  });
});
