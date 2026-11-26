import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerifyResult } from "@pneuma-framework/host-kit/governed-change";
import { runCommand } from "./space";

// ---------------------------------------------------------------------------
// What the test check covered.
//
// "npm-test: passed" says nothing about which code was tested. In an app made
// from the PneumaSpace template, `npm test` once ran only the SDK's own tests.
// So the Host records what ran: the number of tests from the runner's summary,
// less the skipped and todo ones, and how many of them are the app's own from a
// second report it asks Node's test runner for. Whatever cannot be read is
// "unknown". Where an app's own code and tests live depends on its template, so
// each edition gives its layout (`AppLayout`); the local edition's is
// `TEMPLATE_LAYOUT`, PneumaSpace's TypeScript template.
// ---------------------------------------------------------------------------

/** The scaffold's verify command, run once, with what the test runner reported about it. */
export interface CheckRun extends VerifyResult {
  /** Node's JUnit report of the run, when the runner wrote one. */
  readonly report?: string;
  /** Why no such report was asked for, when it was not. */
  readonly no_report?: string;
}

export type Count = number | "unknown";

export interface TestCoverage {
  /** Tests that ran: the runner's summary count less the skipped and todo ones. */
  readonly tests: Count;
  /** Tests the runner skipped or left as todo. They did not run. */
  readonly skipped: Count;
  /** Test files those tests were in, from the JUnit report. */
  readonly test_files: Count;
  /** Tests in files outside the layout's vendored directory (`sdk/` in the local template): the app's own. */
  readonly app_tests: Count;
  readonly app_test_files: Count;
  /**
   * Test files (`*.test.*`) in the layout's test directory in what was checked, whether or not they ran. The name is
   * from the local template, whose tests live in src/; for another layout it lists that layout's test directory.
   */
  readonly src_test_files?: readonly string[];
  /** One plain sentence saying the above, for history. */
  readonly note: string;
}

/** Where an app made from one template keeps its own code and its own tests. */
export interface AppLayout {
  /** Paths a change can touch that are the app's own code. A change to any of them is expected to come with a test. */
  readonly code_roots: readonly string[];
  /** The directory, relative to the app, where the app's own tests go, e.g. `src`. */
  readonly test_dir: string;
  /** What a test file there is called, for the advice, e.g. `*.test.ts`. */
  readonly test_file: string;
  /** A directory whose tests are not the app's own but a part the template ships, and whose they are, e.g. `sdk` and "the SDK's". */
  readonly vendored?: { readonly dir: string; readonly whose: string };
}

/** PneumaSpace's TypeScript app template, which the local edition creates apps from. */
export const TEMPLATE_LAYOUT: AppLayout = { code_roots: ["src/", "public/app/"], test_dir: "src", test_file: "*.test.ts", vendored: { dir: "sdk", whose: "the SDK's" } };

/** Paths a change can touch that are the app's own code, in the local template. */
export const APP_CODE_ROOTS = TEMPLATE_LAYOUT.code_roots;

/**
 * `NODE_OPTIONS` that keep the runner's usual output on stdout and add a JUnit report in `file`. Node's
 * JUnit report names each test's file from Node 24 on; older runners leave it out, and the app's own
 * share is then unknown. A process that is not a test run ignores these options.
 */
export function withJunitReport(nodeOptions: string | undefined, file: string): string {
  const destination = /\s/.test(file) ? `"${file}"` : file;
  return [nodeOptions?.trim(), "--test-reporter=spec", "--test-reporter-destination=stdout", "--test-reporter=junit", `--test-reporter-destination=${destination}`]
    .filter(Boolean)
    .join(" ");
}

/**
 * The scripts `npm test` runs: pretest, test and posttest, and each script one of them runs with `npm run <name>`
 * (with its own pre and post scripts), in turn. Other scripts, such as a `test:watch`, do not run in the check.
 */
function testScripts(scripts: Record<string, unknown>): string[] {
  const found: string[] = [];
  const names = ["pretest", "test", "posttest"];
  for (let i = 0; i < names.length; i++) {
    const script = scripts[names[i]!];
    if (typeof script !== "string") continue;
    found.push(script);
    for (const [, name] of script.matchAll(/\bnpm\s+run(?:-script)?\s+([^\s;&|'"]+)/g)) {
      for (const next of [`pre${name}`, name!, `post${name}`]) if (!names.includes(next)) names.push(next);
    }
  }
  return found;
}

/** A script `npm test` runs that picks its own test reporter. Node refuses to start when the reporters it is given outnumber their destinations. */
function picksOwnReporter(root: string): boolean {
  try {
    const scripts = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, unknown> }).scripts ?? {};
    return testScripts(scripts).some((script) => script.includes("--test-reporter"));
  } catch {
    return false;
  }
}

/** What Node prints when the reporters in NODE_OPTIONS and those on its command line do not pair up. */
const REPORTER_CLASH = "must match the number of specified '--test-reporter-destination'";

/**
 * Run the verify command in `root` and keep the JUnit report Node's test runner writes beside its usual output.
 * A test script that picks its own reporter is run as it is, without the report: the report is the Host's
 * addition and must not change whether the check passes.
 */
export async function runCheckCommand(root: string, command: string, timeoutMs = 600_000): Promise<CheckRun> {
  const plain = async (no_report: string): Promise<CheckRun> => {
    const result = await runCommand(["sh", "-c", command], { cwd: root, timeoutMs });
    return { ok: result.code === 0, output: result.output, no_report };
  };
  if (picksOwnReporter(root)) return plain("the test script picks its own reporter, so this Host did not ask for a per-file report");
  const dir = mkdtempSync(join(tmpdir(), "appgov-report-"));
  const file = join(dir, "junit.xml");
  try {
    const result = await runCommand(["sh", "-c", command], { cwd: root, timeoutMs, env: { NODE_OPTIONS: withJunitReport(process.env.NODE_OPTIONS, file) } });
    if (result.code !== 0 && result.output.includes(REPORTER_CLASH)) {
      // Node refused the extra reporters before running a test. The check runs again as the scaffold wrote it.
      return plain("Node refused the per-file report beside the reporter the tests pick themselves, so the check ran again without it");
    }
    return { ok: result.code === 0, output: result.output, ...(existsSync(file) ? { report: readFileSync(file, "utf8") } : {}) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unxml = (value: string) => value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => XML_ENTITIES[name]!);

/** The single "<name> N" line of a spec (`ℹ tests N`) or TAP (`# tests N`) summary. More than one run, or none: unknown. */
function summaryLine(plain: string, name: string): Count {
  const found = [...plain.matchAll(new RegExp(`^\\s*(?:ℹ|#) ${name} (\\d+)\\s*$`, "gm"))];
  return found.length === 1 ? Number(found[0]![1]) : "unknown";
}

/**
 * Tests that ran and tests that did not (skipped or todo), from the summary. Node counts all of them in "tests",
 * a test with subtests among them; it counts describe blocks apart, in "suites".
 */
function summaryTests(output: string): { ran: Count; skipped: Count; suites: Count } {
  const plain = output.replace(/\u001b\[[0-9;]*m/g, "");
  const tests = summaryLine(plain, "tests");
  const skipped = summaryLine(plain, "skipped");
  const todo = summaryLine(plain, "todo");
  const suites = summaryLine(plain, "suites");
  if (tests === "unknown" || skipped === "unknown" || todo === "unknown") return { ran: "unknown", skipped: "unknown", suites };
  return { ran: tests - skipped - todo, skipped: skipped + todo, suites };
}

/** A JUnit report's tests, each as its file relative to the directory the check ran in. */
interface ReportShape {
  /** Each test case that ran (a <testcase> without <skipped>): a test with no subtests. */
  readonly cases: readonly string[];
  /** Each group (a <testsuite>): a describe block, or a test with subtests. Node writes both the same way. */
  readonly groups: readonly string[];
}

/**
 * The cases and groups of a JUnit report. Null when a case has no file under `roots`, or a group does not hold
 * cases of exactly one file. Skipped and todo cases carry a <skipped> element and are left out of `cases`.
 */
function reportShape(report: string, roots: readonly string[]): ReportShape | null {
  const cases: string[] = [];
  const groups: string[] = [];
  // The files of the cases in each group still open, innermost last.
  const open: Set<string>[] = [];
  for (const [token, attrs, body] of report.matchAll(/<testsuite\b[^>]*>|<\/testsuite>|<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    if (token.startsWith("<testsuite")) {
      open.push(new Set());
      continue;
    }
    if (token === "</testsuite>") {
      const files = open.pop();
      if (!files || files.size !== 1) return null;
      const file = [...files][0]!;
      groups.push(file);
      open.at(-1)?.add(file);
      continue;
    }
    const raw = /\bfile="([^"]*)"/.exec(attrs ?? "")?.[1];
    if (raw === undefined) return null;
    const path = unxml(raw);
    const root = roots.find((candidate) => path.startsWith(`${candidate}/`));
    if (!root) return null;
    const file = path.slice(root.length + 1);
    open.at(-1)?.add(file);
    if (!/<skipped\b/.test(body ?? "")) cases.push(file);
  }
  return open.length ? null : { cases, groups };
}

interface Split {
  readonly test_files: number;
  readonly app_tests: number;
  readonly app_test_files: number;
}

/**
 * The tests that ran, split into the app's own and the vendored ones, from the report's shape and the summary's
 * counts. Node's summary counts a test with subtests as a test, and its report writes that test as a group around
 * its subtests, as it writes a describe block, which the summary counts apart. So every test that ran and is not a
 * case is a group, and the report does not say which groups they are: "ambiguous" when the split depends on it,
 * "mismatch" when the numbers cannot describe the same run.
 */
function splitTests(shape: ReportShape, ran: number, suites: Count, vendored: AppLayout["vendored"]): Split | "mismatch" | "ambiguous" {
  const isVendored = (file: string) => Boolean(vendored && file.startsWith(`${vendored.dir}/`));
  const groups = shape.groups.length;
  const parents = ran - shape.cases.length;
  if (parents < 0 || parents > groups || (suites !== "unknown" && groups - parents > suites)) return "mismatch";
  const appGroups = shape.groups.filter((file) => !isVendored(file)).length;
  // The app's tests with subtests: the fewest and the most any choice of groups allows. Known when they meet.
  const fewest = Math.max(0, parents - (groups - appGroups));
  const most = Math.min(parents, appGroups);
  if (fewest !== most) return "ambiguous";
  // A file where only groups ran (each case in it skipped) holds a test that ran only if one of those groups is a test.
  const caseFiles = new Set(shape.cases);
  const groupOnly = new Set(shape.groups.filter((file) => !caseFiles.has(file)));
  if (groupOnly.size && parents !== 0 && parents !== groups) return "ambiguous";
  const files = new Set([...caseFiles, ...(parents === groups ? groupOnly : [])]);
  return {
    test_files: files.size,
    app_tests: shape.cases.filter((file) => !isVendored(file)).length + fewest,
    app_test_files: [...files].filter((file) => !isVendored(file)).length,
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

/** Test files under `<root>/<dir>`, as paths relative to root. */
function testFilesIn(root: string, dir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, rel: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules") continue;
      if (entry.isDirectory()) walk(join(dir, entry.name), `${rel}/${entry.name}`);
      else if (TEST_FILE.test(entry.name)) found.push(`${rel}/${entry.name}`);
    }
  };
  walk(join(root, dir), dir);
  return found.sort();
}

const shortList = (items: readonly string[]) => (items.length > 3 ? `${items.slice(0, 3).join(", ")} and ${items.length - 3} more` : items.join(", "));

/**
 * What a test check ran, read from the runner's output and its JUnit report. `root` is the directory the
 * check ran in. Nothing is inferred: a count the runner did not report, or a report that does not agree with
 * the summary, is "unknown".
 */
export function testCoverage(run: CheckRun, root: string, layout: AppLayout = TEMPLATE_LAYOUT): TestCoverage {
  const { ran: tests, skipped, suites } = summaryTests(run.output);
  const roots = [root, ...(existsSync(root) ? [realpathSync(root)] : [])];
  const shape = run.report === undefined ? null : reportShape(run.report, roots);
  const vendored = layout.vendored;
  // The report must describe the same run as the summary, test for test.
  const split = shape !== null && tests !== "unknown" ? splitTests(shape, tests, suites, vendored) : null;
  const usable = typeof split === "object" && split !== null ? split : null;
  const test_files: Count = usable ? usable.test_files : "unknown";
  const app_tests: Count = usable ? usable.app_tests : tests === 0 ? 0 : "unknown";
  const app_test_files: Count = usable ? usable.app_test_files : tests === 0 ? 0 : "unknown";
  const src_test_files = testFilesIn(root, layout.test_dir);
  const notRun = typeof skipped === "number" && skipped > 0 ? ` ${plural(skipped, "more test")} ${skipped === 1 ? "was" : "were"} skipped or todo.` : "";
  const unran = app_tests === 0 && src_test_files.length ? ` ${layout.test_dir}/ has test files that did not run: ${shortList(src_test_files)}.` : "";

  let note: string;
  if (tests === "unknown") {
    note = "What the test check ran is unknown: its output has no test runner summary this Host can read.";
  } else if (tests === 0) {
    note = `No tests ran.${notRun}${unran}`;
  } else if (app_tests === "unknown") {
    const why =
      run.report === undefined
        ? (run.no_report ?? "the runner wrote no per-file report (this Host asks Node's test runner for one)")
        : shape === null
          ? "the runner's per-file report does not name each test's file (Node's test runner does from Node 24 on)"
          : split === "ambiguous"
            ? "the runner's per-file report writes tests with subtests and describe blocks alike, and here it matters which is which"
            : "the runner's per-file report does not match its summary";
    note = `${plural(tests, "test")} ran; how many of them are the app's own is unknown: ${why}.${notRun}`;
  } else if (app_tests === 0) {
    // Only possible with a vendored directory: every test that ran was in it.
    note = `${plural(tests, "test")} ran in ${plural(test_files as number, "file")}, all of them ${vendored!.whose} (${vendored!.dir}/); none of the app's own.${notRun}${unran}`;
  } else if (!vendored) {
    // Without a vendored directory every test that ran is the app's own.
    note = `${plural(tests, "test")} ran in ${plural(test_files as number, "file")}, all of them the app's own.${notRun}`;
  } else {
    note = `${plural(tests, "test")} ran in ${plural(test_files as number, "file")}. The app's own: ${plural(app_tests, "test")} in ${plural(app_test_files as number, "file")}; the rest are ${vendored!.whose} (${vendored!.dir}/).${notRun}`;
  }
  return { tests, skipped, test_files, app_tests, app_test_files, src_test_files, note };
}

/**
 * One line for the agent when a change touched the app's own code and none of the app's own tests ran, or when
 * that cannot be told. Nothing when the change touched no app code, or when app tests ran. It blocks nothing.
 */
export function testWarning(changedPaths: readonly string[], coverage: TestCoverage | undefined, layout: AppLayout = TEMPLATE_LAYOUT): string | undefined {
  const code = changedPaths.filter((path) => layout.code_roots.some((root) => path.startsWith(root)));
  if (!code.length || !coverage) return undefined;
  const shown = shortList(code);
  if (coverage.app_tests === 0) {
    const present = coverage.src_test_files ?? [];
    return present.length
      ? `warning: this change touched app code (${shown}) and none of the app's own tests ran, although ${layout.test_dir}/ has test files (${shortList(present)}). Check that the test script in package.json runs them and that they are not skipped.`
      : `warning: this change touched app code (${shown}) and none of the app's own tests ran. Add a test for it as a ${layout.test_file} file under ${layout.test_dir}/.`;
  }
  if (coverage.app_tests === "unknown") return `note: this change touched app code (${shown}); whether any of the app's own tests ran is unknown. ${coverage.note}`;
  return undefined;
}
