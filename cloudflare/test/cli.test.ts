import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
