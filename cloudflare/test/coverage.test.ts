import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testCoverage, testWarning } from "../../host/src/test-coverage";
import { CF_LAYOUT, TEMPLATE } from "../src/edition";

// What the test check covered, with this edition's layout: app code under app/, the app's tests under tests/.
// The shapes are what Node's test runner prints: the spec summary and, with a second reporter, a JUnit report.
const summary = (tests: number, skipped = 0) =>
  `\n> test\n> node --test "tests/**/*.test.mjs"\n\nℹ tests ${tests}\nℹ suites 0\nℹ pass ${tests - skipped}\nℹ fail 0\nℹ cancelled 0\nℹ skipped ${skipped}\nℹ todo 0\nℹ duration_ms 90`;
const junit = (files: readonly string[], skipped: readonly string[] = []) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n${files
    .map((file, i) => `\t<testcase name="t${i}" time="0.001" classname="test" file="${file}"/>`)
    .concat(skipped.map((file, i) => `\t<testcase name="s${i}" time="0.001" classname="test" file="${file}">\n\t\t<skipped type="skipped" message="true"/>\n\t</testcase>`))
    .join("\n")}\n</testsuites>\n`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
/** A checked copy of the template, as the Host makes one before it runs the tests. */
function checked(): string {
  const root = mkdtempSync(join(tmpdir(), "appgov-check-"));
  dirs.push(root);
  cpSync(TEMPLATE, root, { recursive: true });
  return root;
}

describe("the test check with this edition's layout", () => {
  test("the template's tests under tests/ are the app's own, and a change to app/ with them passing has no warning", () => {
    const root = checked();
    const coverage = testCoverage({ ok: true, output: summary(2), report: junit([`${root}/tests/server.test.mjs`, `${root}/tests/server.test.mjs`]) }, root, CF_LAYOUT);
    expect(coverage).toMatchObject({ tests: 2, app_tests: 2, app_test_files: 1, note: "2 tests ran in 1 file, all of them the app's own." });
    expect(coverage.note).not.toContain("sdk");
    expect(testWarning(["app/server.mjs"], coverage, CF_LAYOUT)).toBeUndefined();
  });

  test("a change to app/ when the tests in tests/ were all skipped: the warning names tests/", () => {
    const root = checked();
    const coverage = testCoverage({ ok: true, output: summary(2, 2), report: junit([], [`${root}/tests/server.test.mjs`, `${root}/tests/server.test.mjs`]) }, root, CF_LAYOUT);
    expect(coverage.app_tests).toBe(0);
    expect(coverage.note).toBe("No tests ran. 2 more tests were skipped or todo. tests/ has test files that did not run: tests/server.test.mjs.");
    expect(testWarning(["app/server.mjs", "tests/server.test.mjs"], coverage, CF_LAYOUT)).toBe(
      "warning: this change touched app code (app/server.mjs) and none of the app's own tests ran, although tests/ has test files (tests/server.test.mjs). Check that the test script in package.json runs them and that they are not skipped.",
    );
  });

  test("a change to app/ with no tests at all: the advice says where a test goes in this layout", () => {
    const root = mkdtempSync(join(tmpdir(), "appgov-check-"));
    dirs.push(root);
    const coverage = testCoverage({ ok: true, output: summary(0) }, root, CF_LAYOUT);
    expect(testWarning(["app/public/app.js"], coverage, CF_LAYOUT)).toBe(
      "warning: this change touched app code (app/public/app.js) and none of the app's own tests ran. Add a test for it as a *.test.mjs file under tests/.",
    );
  });

  test("a change outside app/ expects no test, and the local template's code paths are not this edition's", () => {
    const root = checked();
    const coverage = testCoverage({ ok: true, output: summary(0) }, root, CF_LAYOUT);
    expect(testWarning(["pneuma-space.json", "PRODUCT.md"], coverage, CF_LAYOUT)).toBeUndefined();
    expect(testWarning(["src/server.ts"], coverage, CF_LAYOUT)).toBeUndefined();
  });

  test("whether the app's own tests ran is unknown without a per-file report, and the note says so", () => {
    const root = checked();
    const coverage = testCoverage({ ok: true, output: summary(2), no_report: "the test script picks its own reporter" }, root, CF_LAYOUT);
    expect(testWarning(["app/server.mjs"], coverage, CF_LAYOUT)).toContain("whether any of the app's own tests ran is unknown");
  });
});
