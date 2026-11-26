import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// The requests an app declares, made against its preview.
//
// A preview that answers its home page shows the app starts, not that it works.
// So an app may list, in `preview.json` in its test directory, the requests that
// show it works: an ordered list of a method, a path inside the app, an optional
// JSON body, and what the reply must be. The Host makes them itself against the
// change's preview, after the preview answers and before the change goes on,
// with the access it already has for its probes. The preview's storage starts
// empty, so a list can store something and read it back.
//
// The boundaries are the design, not gaps: the requests go only to the preview,
// never to the live app; the agent writes data, not code that runs with a
// credential; a path cannot leave the preview (no absolute URLs, no `..`, and a
// redirect is a status, never followed); the number of requests, the sizes and
// the time are capped. What the agent is shown comes from the preview, whose
// code is its own and whose storage held nothing before these requests.
// ---------------------------------------------------------------------------

/** The file's name, in the layout's test directory (src/ in the local template, tests/ in the Cloudflare one). */
export const PREVIEW_REQUESTS_FILE = "preview.json";

export const PREVIEW_REQUEST_LIMITS = {
  requests: 20,
  /** A request body, as JSON. */
  bodyBytes: 16_384,
  pathChars: 512,
  containsChars: 200,
  /** How much of a reply is read to look for `contains`. */
  replyBytes: 65_536,
  /** How much of a reply a failure shows. */
  excerptChars: 400,
  /** One request: a preview woke for the probe, so a reply that takes longer than this is a fault of the app. */
  eachMs: 20_000,
  /** All of them together. */
  totalMs: 90_000,
} as const;

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type PreviewMethod = (typeof METHODS)[number];

export interface PreviewRequest {
  readonly method: PreviewMethod;
  /** Inside the app: `/api/items` goes to the preview's `/apps/<preview>/api/items`. */
  readonly path: string;
  /** Sent as JSON, with `content-type: application/json`. */
  readonly body?: unknown;
  readonly expect: { readonly status: number; readonly contains?: string };
}

/** What the preview answered one request: its status and the start of its reply, or why there was no reply. */
export interface AppReply {
  readonly status: number;
  readonly body: string;
  /** No reply: the request could not be made, or timed out. `status` is 0 then. */
  readonly error?: string;
}

/** Make one request to the preview `app`, at `path` inside it. The runtime refuses a path that leaves the app. */
export type SendToPreview = (app: string, request: { readonly method: PreviewMethod; readonly path: string; readonly body?: string }) => Promise<AppReply>;

/** What the preview showed, for the record, `submit` and `history`. */
export interface PreviewRequestFacts {
  /** The file, relative to the app (`src/preview.json`), whether or not it exists. */
  readonly file: string;
  /** Requests the file lists; 0 when it is absent or lists none. */
  readonly declared: number;
  /** Requests made (all of them, unless time ran out). */
  readonly made: number;
  /** Requests whose reply was as expected. */
  readonly answered: number;
  /** One plain sentence saying the above. */
  readonly note: string;
}

export type ReadRequests =
  | { readonly ok: true; readonly requests: readonly PreviewRequest[]; readonly file: string; readonly present: boolean }
  | { readonly ok: false; readonly file: string; readonly detail: string };

/** The app's requests, from `<testDir>/preview.json` in `root`; none when the file is absent. A file that is there must be valid. */
export function readPreviewRequests(root: string, testDir: string): ReadRequests {
  const file = `${testDir}/${PREVIEW_REQUESTS_FILE}`;
  const full = join(root, testDir, PREVIEW_REQUESTS_FILE);
  if (!existsSync(full)) return { ok: true, requests: [], file, present: false };
  const bad = (why: string): ReadRequests => ({ ok: false, file, detail: `${file}: ${why}. ${FORMAT}` });
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(full, "utf8"));
  } catch (err) {
    return bad(`not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const list = (parsed as { requests?: unknown } | null)?.requests;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !Array.isArray(list)) return bad('it must be an object with a "requests" list');
  if (list.length > PREVIEW_REQUEST_LIMITS.requests) return bad(`it lists ${list.length} requests; at most ${PREVIEW_REQUEST_LIMITS.requests} are made`);
  const requests: PreviewRequest[] = [];
  for (const [i, item] of list.entries()) {
    const at = `request ${i + 1}`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) return bad(`${at} is not an object`);
    const { method = "GET", path, body, expect, ...rest } = item as Record<string, unknown>;
    const unknown = Object.keys(rest);
    if (unknown.length) return bad(`${at} has ${unknown.map((key) => `"${key}"`).join(", ")}, which the format does not have`);
    if (typeof method !== "string" || !(METHODS as readonly string[]).includes(method.toUpperCase())) return bad(`${at}: "method" is one of ${METHODS.join(", ")}`);
    const where = pathProblem(path);
    if (where) return bad(`${at}: "path" ${where}`);
    if (body !== undefined && Buffer.byteLength(JSON.stringify(body)) > PREVIEW_REQUEST_LIMITS.bodyBytes) return bad(`${at}: "body" is over ${PREVIEW_REQUEST_LIMITS.bodyBytes} bytes as JSON`);
    if (body !== undefined && method.toUpperCase() === "GET") return bad(`${at}: a GET has no "body"`);
    const e = (expect ?? {}) as Record<string, unknown>;
    if (typeof expect !== "object" || expect === null || Array.isArray(expect)) return bad(`${at}: "expect" is an object, e.g. {"status": 200}`);
    const { status, contains, ...more } = e;
    if (Object.keys(more).length) return bad(`${at}: "expect" has ${Object.keys(more).map((key) => `"${key}"`).join(", ")}; it takes "status" and "contains"`);
    if (!Number.isInteger(status) || (status as number) < 100 || (status as number) > 599) return bad(`${at}: "expect" needs "status", a whole number from 100 to 599`);
    if (contains !== undefined && (typeof contains !== "string" || !contains || contains.length > PREVIEW_REQUEST_LIMITS.containsChars)) {
      return bad(`${at}: "contains" is a string of 1 to ${PREVIEW_REQUEST_LIMITS.containsChars} characters`);
    }
    requests.push({
      method: method.toUpperCase() as PreviewMethod,
      path: path as string,
      ...(body !== undefined ? { body } : {}),
      expect: { status: status as number, ...(contains !== undefined ? { contains: contains as string } : {}) },
    });
  }
  return { ok: true, requests, file, present: true };
}

const FORMAT =
  'The format: {"requests": [{"method": "POST", "path": "/api/items", "body": {"title": "x"}, "expect": {"status": 201}}, {"path": "/api/items", "expect": {"status": 200, "contains": "x"}}]}; ' +
  '"method" defaults to GET, "body" is optional JSON, "contains" is optional';

/** Why a path cannot be requested, or undefined. A path stays inside the app: it starts with one "/", and has no "..", no "\\", no "#", no spaces and no encoded dot. */
export function pathProblem(path: unknown): string | undefined {
  if (typeof path !== "string" || !path) return 'is missing; it is a path inside the app, such as "/api/items"';
  if (path.length > PREVIEW_REQUEST_LIMITS.pathChars) return `is over ${PREVIEW_REQUEST_LIMITS.pathChars} characters`;
  if (!path.startsWith("/") || path.startsWith("//")) return `must start with a single "/": it is a path inside the app, not an address (${JSON.stringify(path.slice(0, 80))})`;
  if (/[\s\\#]/.test(path) || /%2e|%2f|%5c/i.test(path) || path.split("?")[0]!.split("/").some((segment) => segment === "..")) {
    return `must stay inside the app: no "..", no "\\", no "#", no spaces and no encoded "." or "/" (${JSON.stringify(path.slice(0, 80))})`;
  }
  return undefined;
}

/**
 * Where a request for `path` inside the app `app` goes, under `base` (the platform's origin, where apps are at
 * `/apps/<name>/`); undefined when it would leave that app, which `pathProblem` already refuses: a second line of defence.
 */
export function previewUrl(base: string, app: string, path: string): URL | undefined {
  if (pathProblem(path)) return undefined;
  const root = new URL(`${base.replace(/\/+$/, "")}/apps/${encodeURIComponent(app)}/`);
  const url = new URL(`${root.pathname}${path.slice(1)}`, root);
  return url.origin === root.origin && (url.pathname === root.pathname.slice(0, -1) || url.pathname.startsWith(root.pathname)) ? url : undefined;
}

/** Read at most `max` bytes of a reply's body as text, then stop reading. */
export async function boundedText(res: Response, max = PREVIEW_REQUEST_LIMITS.replyBytes): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, max));
}

const excerpt = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_REQUEST_LIMITS.excerptChars ? `${flat.slice(0, PREVIEW_REQUEST_LIMITS.excerptChars)}… (first ${PREVIEW_REQUEST_LIMITS.excerptChars} characters)` : flat || "(empty)";
};

/** What the record says when there is nothing to make: the preview only showed the app starts. */
export function noRequestsFacts(file: string, present: boolean): PreviewRequestFacts {
  return {
    file,
    declared: 0,
    made: 0,
    answered: 0,
    note: `The preview showed only that the app starts: ${present ? `${file} lists no requests` : `the app has no ${file}`}, so none of its routes was tried on the platform.`,
  };
}

/**
 * Make the requests in order against the preview `app`, each once, all of them even after one fails (a later one may
 * show more), until the time runs out. Returns the facts for the record and, per failing request, what was sent and
 * what came back.
 */
export async function makePreviewRequests(
  app: string,
  file: string,
  requests: readonly PreviewRequest[],
  send: SendToPreview,
): Promise<{ facts: PreviewRequestFacts; failures: readonly string[] }> {
  if (!requests.length) return { facts: noRequestsFacts(file, true), failures: [] };
  const deadline = Date.now() + PREVIEW_REQUEST_LIMITS.totalMs;
  const failures: string[] = [];
  let made = 0;
  let answered = 0;
  for (const [i, request] of requests.entries()) {
    const sent = `${request.method} ${request.path}${request.body !== undefined ? ` ${excerpt(JSON.stringify(request.body))}` : ""}`;
    const head = `request ${i + 1} of ${requests.length}: ${sent}`;
    if (Date.now() >= deadline) {
      failures.push(`${head}\n  not made: the requests took longer than ${PREVIEW_REQUEST_LIMITS.totalMs / 1000} s together`);
      continue;
    }
    made++;
    const reply = await send(app, { method: request.method, path: request.path, ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}) });
    const wanted = `status ${request.expect.status}${request.expect.contains !== undefined ? ` and a reply that contains ${JSON.stringify(request.expect.contains)}` : ""}`;
    if (reply.error) {
      failures.push(`${head}\n  expected: ${wanted}\n  got: no reply (${reply.error})`);
      continue;
    }
    const statusOk = reply.status === request.expect.status;
    const containsOk = request.expect.contains === undefined || reply.body.includes(request.expect.contains);
    if (statusOk && containsOk) {
      answered++;
      continue;
    }
    const missing = statusOk && !containsOk ? `, and the reply does not contain ${JSON.stringify(request.expect.contains)}` : "";
    failures.push(`${head}\n  expected: ${wanted}\n  got: status ${reply.status}${missing}; the reply: ${excerpt(reply.body)}`);
  }
  const all = answered === requests.length;
  const note = all
    ? `${answered} request${answered === 1 ? "" : "s"} the app declares in ${file} answered as expected on the preview.`
    : `${answered} of the ${requests.length} requests the app declares in ${file} answered as expected on the preview.`;
  return { facts: { file, declared: requests.length, made, answered, note }, failures };
}

/** The refusal's text: what failed, per request, and what to do. The replies come from the preview, whose storage started empty. */
export function refusalText(facts: PreviewRequestFacts, failures: readonly string[], preview: string): string {
  return (
    `${facts.note} What the preview ${preview} answered (its storage started empty, and the requests ran in order):\n` +
    `${failures.join("\n")}\n` +
    `Fix the app, or the request in ${facts.file} if it expects the wrong thing, then submit again.`
  );
}
