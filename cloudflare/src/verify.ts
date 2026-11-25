import { measured } from "../../host/src/steps";
import type { CheckRun } from "../../host/src/test-coverage";

// ---------------------------------------------------------------------------
// The app's tests, run as another user.
//
// The Host runs as the unix user `host`. The tests are code the agent wrote, so
// they run as the user `tests`, which cannot read the Host's files or its
// environment (the PneumaSpace token, the secret the Worker sends). Only root
// can switch users, so the container's supervisor (container/supervisor.mjs,
// root) does it: it listens on a unix socket only `host` may open, copies the
// checked tree into a directory of its own, runs the command there as `tests`
// with a clean environment, and hands back the output and Node's JUnit report.
// This is one container with two users, not a sandbox: see the README's limits.
// ---------------------------------------------------------------------------

/** What Node prints when the reporters in NODE_OPTIONS and those on its command line do not pair up. */
const REPORTER_CLASH = "must match the number of specified '--test-reporter-destination'";

interface SupervisorAnswer {
  readonly code: number;
  readonly output: string;
  readonly report?: string;
  /** Where the supervisor ran the command; the report names test files by their path there. */
  readonly ran_in?: string;
  /** How long copying the tree for the user `tests` took, and each part of the command (`npm ci`, `npm test`). */
  readonly copy_ms?: number;
  readonly steps?: readonly { readonly command: string; readonly ms: number; readonly code: number }[];
}

/** The supervisor's own timings, as steps of the operation being timed. */
function recordSteps(answer: SupervisorAnswer): void {
  if (answer.copy_ms !== undefined) measured("copy the tree for the user tests", answer.copy_ms);
  for (const step of answer.steps ?? []) measured(step.command, step.ms);
}

export type SupervisorCall = (body: { source: string; command: string; report: boolean; timeout_ms: number }) => Promise<SupervisorAnswer>;

/** Calls the supervisor over its unix socket, with Bun's fetch. */
export function socketSupervisor(socket: string): SupervisorCall {
  return async (body) => {
    const res = await fetch("http://supervisor/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      // Bun's fetch takes a unix socket this way.
      unix: socket,
    } as RequestInit);
    const value = (await res.json()) as SupervisorAnswer & { error?: string };
    if (!res.ok) throw new Error(`the supervisor did not run the tests: ${value.error ?? res.status}`);
    return value;
  };
}

/**
 * The Host's `runVerify` for this edition: the scaffold's command in `root`, as the user `tests`, with Node's
 * JUnit report beside the usual output so the history can say how many tests are the app's own. The report's file
 * paths are put back under `root`, where the Host reads them.
 */
export function supervisedVerify(call: SupervisorCall, timeoutMs = 600_000): (root: string, command: string) => Promise<CheckRun> {
  return async (root, command) => {
    let answer: SupervisorAnswer;
    try {
      answer = await call({ source: root, command, report: true, timeout_ms: timeoutMs });
      recordSteps(answer);
      if (answer.code !== 0 && answer.output.includes(REPORTER_CLASH)) {
        const plain = await call({ source: root, command, report: false, timeout_ms: timeoutMs });
        recordSteps(plain);
        return { ok: plain.code === 0, output: plain.output, no_report: "Node refused the per-file report beside the reporter the tests pick themselves, so the check ran again without it" };
      }
    } catch (err) {
      return { ok: false, output: err instanceof Error ? err.message : String(err), no_report: "the tests did not run" };
    }
    const report = answer.report && answer.ran_in ? answer.report.split(answer.ran_in).join(root) : answer.report;
    return { ok: answer.code === 0, output: answer.output, ...(report !== undefined ? { report } : {}) };
  };
}
