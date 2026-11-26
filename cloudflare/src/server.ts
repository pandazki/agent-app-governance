import { timingSafeEqual } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { appPaths, openRecord } from "../../host/src/artifact";
import { AGENT_SOURCES, AppHost, HostError, type AgentProvenance } from "../../host/src/host";
import { collectSteps, timedSync } from "../../host/src/steps";
import { dataLeft, dataLeftLine } from "./data-left";
import { copySignature, exportWorkingCopy, packFolder, replaceWorkingTree, unpackFolder } from "./folder";
import { APP_HEADER, APP_NAME, CHANNEL_HEADER, FOLDER_HEADER, HISTORY_KEPT, PAGE_CHANNEL, PLANS_KEPT, PRINCIPAL_HEADER, SECRET_HEADER, VIEW_SCHEMA, type Principal, type StoredView } from "./protocol";

// ---------------------------------------------------------------------------
// The Host's HTTP face inside the container.
//
// Only the app's Durable Object reaches this port from outside the container.
// Inside it, the app's tests run as another unix user and could reach it on
// localhost, so every request but /ready must carry the secret the Worker and
// the container share; that user cannot read it. With the secret, the Host
// trusts the principal the Worker authenticated: the owner, or an agent token.
// The owner's subject in every app's governance is `ownerSubject`; an agent
// token acts as `agent:token-<id>`, which holds no role.
//
// The record names who acted from that principal, not from what the CLI says
// about its environment: an operation with the owner's session is the owner's
// (`owner`, control `owner`), wherever the CLI ran; one with an agent token is
// recorded with the agent the CLI detected (or `unknown`). Either way the entry
// names the credential (`owner session`, or the token's label and id).
//
// Besides the Host's own routes, the Durable Object loads and saves the app's
// folder here (see worker/folders.ts), and every route about an app checks that
// the folder on disk is the one the Durable Object read from R2.
// ---------------------------------------------------------------------------

export interface ContainerServerOptions {
  readonly host: AppHost;
  readonly appsDir: string;
  readonly secret: string;
  /** The subject that holds the owner role in every app this Host creates. */
  readonly ownerSubject: string;
  /** Which build of the Host this is, as `/ready` reports it. */
  readonly build?: string;
  readonly log?: (line: string) => void;
}

const MAX_BODY = 48 * 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HostError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = (await readBody(req)).toString("utf8");
  if (!text.trim()) return {};
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HostError(400, "request body must be a JSON object");
  }
}

const text = (value: unknown, field: string, fallback?: string): string => {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (fallback !== undefined) return fallback;
  throw new HostError(400, `${field} is required`);
};

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * The versions `version` was built on, newest first, by the rule undo follows (host/src/host.ts `builtOn`, and the
 * owner page's `lineage` in local/src/page-views.ts, which this image does not carry): the versions it can go back to.
 */
function builtOnChain(history: readonly { kind?: string; version?: unknown; base_version?: unknown }[], version: string | null): string[] {
  const out: string[] = [];
  const baseOf = (v: string) => history.find((entry) => entry.version === v && entry.kind !== "restore")?.base_version;
  for (let at = version ? baseOf(version) : undefined; typeof at === "string" && !out.includes(at) && at !== version; at = baseOf(at)) out.push(at);
  return out;
}

type Entry = { kind?: string; version?: unknown; base_version?: unknown; data_ref?: { ref?: unknown } };

/**
 * The history entries the owner page reads beside a plan for going back (local/src/page-views.ts `backModel`): the ones
 * that made the current version and each version it was built on down to the one gone back to, the ones that made the
 * versions the plan undoes, and the ones that saved the data it would bring back. In the history's order, and only
 * those older than the first `skip` from the end: a plan stored with a view leaves out what the view's history holds.
 */
function planEntries(history: readonly Entry[], plan: { from: string | null; target: string; undone: readonly string[]; oneWay: readonly { version?: string }[]; dataRef?: { ref: string } }, skip = 0): Entry[] {
  const versions = new Set<string>([plan.target, ...plan.undone, ...plan.oneWay.map((o) => String(o.version ?? ""))]);
  if (plan.from) {
    versions.add(plan.from);
    for (const v of builtOnChain(history, plan.from)) {
      versions.add(v);
      if (v === plan.target) break;
    }
  }
  const making = new Set<Entry>();
  for (const v of versions) {
    const made = history.find((entry) => entry.version === v && entry.kind !== "restore");
    if (made) making.add(made);
  }
  const ref = plan.dataRef?.ref;
  return history.slice(0, Math.max(0, history.length - skip)).filter((entry) => making.has(entry) || (ref !== undefined && entry.data_ref?.ref === ref));
}

/** How the record names the credential a request was authenticated with. */
export function credentialOf(principal: Principal): string {
  return principal.kind === "owner" ? "owner session" : `agent token ${JSON.stringify(principal.label)} (${principal.id})`;
}

/** As the local edition's server reads it (local/src/server.ts): where the submitting CLI says the agent's name came from. */
function provenance(input: Record<string, unknown>, agent: string): AgentProvenance | undefined {
  const { agent_source: source, agent_markers: markers, agent_candidates: candidates } = input;
  if (source === undefined) return undefined;
  if (typeof source !== "string" || !(AGENT_SOURCES as readonly string[]).includes(source)) throw new HostError(400, `agent_source must be one of ${AGENT_SOURCES.join(", ")}`);
  if (markers !== undefined && !strings(markers)) throw new HostError(400, "agent_markers must be a list of environment variable names");
  if (candidates !== undefined && !(Array.isArray(candidates) && candidates.every((c) => typeof c === "object" && c !== null && typeof c.agent === "string" && strings(c.markers)))) {
    throw new HostError(400, "agent_candidates must be a list of { agent, markers }");
  }
  if (source === "ambiguous" && agent !== "unknown") throw new HostError(400, 'with markers of more than one agent the agent is recorded as "unknown", not as one of them');
  return { source: source as AgentProvenance["source"], ...(markers ? { markers } : {}), ...(candidates ? { candidates: candidates as AgentProvenance["candidates"] } : {}) };
}

function sameSecret(sent: string | undefined, secret: string): boolean {
  const a = Buffer.from(sent ?? "");
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Where an owner's decision or undo came from: the owner page, when the Worker says so; the CLI otherwise. */
function channelOf(req: IncomingMessage): string | undefined {
  return req.headers[CHANNEL_HEADER] === PAGE_CHANNEL ? PAGE_CHANNEL : undefined;
}

function principalOf(req: IncomingMessage): Principal {
  let value: unknown;
  try {
    value = JSON.parse(String(req.headers[PRINCIPAL_HEADER] ?? ""));
  } catch {
    throw new HostError(401, "no principal: this port answers the app's Durable Object only");
  }
  const p = value as Record<string, unknown>;
  if (p?.kind === "owner") return { kind: "owner" };
  if (p?.kind === "agent" && typeof p.id === "string" && typeof p.label === "string") return { kind: "agent", id: p.id, label: p.label };
  throw new HostError(401, "the principal is not one this Host knows");
}

export function createContainerServer(opts: ContainerServerOptions) {
  const { host, appsDir, secret, ownerSubject } = opts;
  const log = opts.log ?? (() => {});
  /** The R2 etag of the folder each app's directory was loaded from, or saved as. Gone when the container restarts. */
  const loaded = new Map<string, string>();
  const startedAt = Date.now();

  const subjectOf = (principal: Principal) => (principal.kind === "owner" ? ownerSubject : `agent:token-${principal.id}`);
  const requireOwner = (principal: Principal, what: string) => {
    if (principal.kind !== "owner") throw new HostError(403, `${what} is the owner's decision; an agent token cannot do it. Sign in as the owner.`, "owner_required");
  };
  const appRoot = (name: string) => appPaths(appsDir, name).root;
  const current = (name: string): string | null => {
    const paths = appPaths(appsDir, name);
    if (!existsSync(paths.info)) throw new HostError(404, `no app named ${name}`);
    return openRecord(paths).current();
  };
  /** A working copy made from a version the app is no longer on would undo what came after it. */
  const checkBase = (name: string, base: unknown) => {
    if (base === undefined || base === null) return;
    if (typeof base !== "string") throw new HostError(400, "base_version must be a version, e.g. v3");
    const now = current(name);
    if (now !== base) {
      throw new HostError(
        409,
        `this working copy is on ${base}, and ${name} is on ${now} now, so a change made here would put back what came after ${base}. Nothing was changed. ` +
          "Bring the working copy up to date with `node .appgov/appgov.mjs fetch` (it refuses while you have edits it would overwrite), then make the change again.",
        "working_copy_behind",
        undefined,
        { current: String(now) },
      );
    }
  };
  /**
   * On this edition the centre's working tree only stages what a submit sent: agents edit their own working copies,
   * and a change that waits keeps its files as a draft of its own. Once a submit or a decision has not released them,
   * the tree goes back to the current version, so they are never taken for edits nobody sent: going back is not
   * refused for them, the owner page does not call them work in progress, and `fetch` gives the version that is
   * current. The answer, with the working copy the CLI mirrors, is taken before.
   */
  const settle = async (name: string, result: unknown) => {
    if ((result as { status?: unknown })?.status === "published") return;
    try {
      await host.discard(name);
    } catch (err) {
      log(`could not put the working tree of ${name} back to its current version: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  /** `GET /apps/<app>`: each waiting change carries its files' signature as the CLI computes one, so a working copy can tell that its edits are that change and not something still to submit. */
  const statusAnswer = async (name: string) => {
    const status = await host.status(name);
    const drafts = appPaths(appsDir, name).drafts;
    // The risks the standing rule lets through in this mode: the owner page lists only the others as why a change waits.
    return { ...status, auto_approved: host.autoApproved, pending: status.pending.map((p) => ({ ...p, tree_signature: copySignature(join(drafts, p.change_id)) })) };
  };
  /**
   * `GET /apps/<app>/undo-plan/<version>`: what going back to a version would do, without doing it, with the history
   * entries the owner page reads beside it (`planEntries`; for the stored view and StoredPlans, the ones older than
   * the view's history).
   */
  const planAnswer = (name: string, to: string, history: readonly Entry[] = host.history(name) as readonly Entry[], skip = 0) => {
    const plan = host.undoPlan(name, to);
    const record = openRecord(appPaths(appsDir, name));
    return { ...plan, data_left: plan.undone.length ? (dataLeft(plan.undone, to, (version) => record.versionDir(version)) ?? null) : null, entries: planEntries(history, plan, skip) };
  };
  /** A plan for the stored view or StoredPlans: null where the Host would not plan it (not a version this one was built on). */
  const planOrNull = (name: string, to: string, history: readonly Entry[]): Record<string, unknown> | null => {
    try {
      return planAnswer(name, to, history, HISTORY_KEPT) as unknown as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  /**
   * What a read of the app needs without a further click, for the Durable Object to store beside the folder (StoredView
   * in protocol.ts): the newest HISTORY_KEPT entries and plans for the PLANS_KEPT nearest versions, whatever the age of the app.
   */
  const viewOf = async (name: string, etag: string): Promise<StoredView> => {
    const history = host.history(name);
    const status = await statusAnswer(name);
    const plans: Record<string, Record<string, unknown> | null> = {};
    for (const version of builtOnChain(history, status.active_version).slice(0, PLANS_KEPT)) plans[version] = planOrNull(name, version, history as readonly Entry[]);
    return {
      schema: VIEW_SCHEMA,
      app: name,
      folder_etag: etag,
      computed_at: new Date().toISOString(),
      status: status as unknown as Record<string, unknown>,
      history: history.slice(-HISTORY_KEPT) as unknown as Record<string, unknown>[],
      history_total: history.length,
      plans,
    };
  };
  const withCopy = (name: string, result: unknown) =>
    existsSync(appPaths(appsDir, name).info)
      ? { ...(result as object), working_copy: timedSync("export the working copy", () => exportWorkingCopy(appRoot(name), name, current(name))) }
      : result;

  const folderRoute = async (req: IncomingMessage, url: URL): Promise<{ status: number; type: string; body: string | Buffer } | null> => {
    const name = url.searchParams.get("app") ?? "";
    if (!APP_NAME.test(name)) throw new HostError(400, "app must be an app name");
    const dir = appRoot(name);
    const method = req.method ?? "GET";
    if (url.pathname === "/folder/load" && method === "POST") {
      const etag = text(req.headers[FOLDER_HEADER], FOLDER_HEADER);
      loaded.delete(name);
      await unpackFolder(dir, await readBody(req));
      loaded.set(name, etag);
      return { status: 200, type: "application/json", body: JSON.stringify({ loaded: etag }) };
    }
    if (url.pathname === "/folder/save" && method === "POST") {
      const tar = await packFolder(dir);
      return tar ? { status: 200, type: "application/x-tar", body: Buffer.from(tar) } : { status: 204, type: "text/plain", body: "" };
    }
    if (url.pathname === "/folder/summary" && method === "GET") {
      const summary = (await host.summaries()).find((s) => s.app_id === name);
      return summary ? { status: 200, type: "application/json", body: JSON.stringify(summary) } : { status: 404, type: "application/json", body: JSON.stringify({ error: `no app named ${name}` }) };
    }
    if ((url.pathname === "/folder/view" || url.pathname === "/folder/check" || url.pathname === "/folder/plan") && method === "GET") {
      // Only of the folder the Durable Object read: otherwise it loads it first, as for any other route.
      const expected = String(req.headers[FOLDER_HEADER] ?? "");
      if (!expected || loaded.get(name) !== expected) throw new HostError(412, `the folder of ${name} on this container is not the one in R2; load it first`, "folder_not_loaded");
      if (url.pathname === "/folder/check") return { status: 204, type: "text/plain", body: "" };
      if (url.pathname === "/folder/plan") {
        // One plan the stored view does not carry, named with the folder it was worked out from (StoredPlans).
        const to = url.searchParams.get("to") ?? "";
        if (!/^v\d+$/.test(to)) throw new HostError(400, "to must be a version name, e.g. v3");
        return { status: 200, type: "application/json", body: JSON.stringify({ app: name, folder_etag: expected, version: to, plan: planOrNull(name, to, host.history(name) as readonly Entry[]) }) };
      }
      return { status: 200, type: "application/json", body: JSON.stringify(await viewOf(name, expected)) };
    }
    if (url.pathname === "/folder/saved" && method === "POST") {
      loaded.set(name, text(url.searchParams.get("etag"), "etag"));
      return { status: 200, type: "application/json", body: "{}" };
    }
    if (url.pathname === "/folder/forget" && method === "POST") {
      loaded.delete(name);
      return { status: 200, type: "application/json", body: "{}" };
    }
    return null;
  };

  /** The folder on disk must be the one the Durable Object read; `none` means there is none yet (create). */
  const checkFolder = (req: IncomingMessage, name: string) => {
    const expected = String(req.headers[FOLDER_HEADER] ?? "");
    if (expected === "none") {
      loaded.delete(name);
      rmSync(appRoot(name), { recursive: true, force: true });
      return;
    }
    if (!expected || loaded.get(name) !== expected) throw new HostError(412, `the folder of ${name} on this container is not the one in R2; load it first`, "folder_not_loaded");
  };

  const apiRoute = async (req: IncomingMessage, url: URL): Promise<unknown> => {
    const principal = principalOf(req);
    const parts = url.pathname.split("/").filter(Boolean);
    const method = req.method ?? "GET";
    if (parts[0] !== "apps") throw new HostError(404, "not found");
    if (parts.length === 1 && method === "POST") {
      const input = await jsonBody(req);
      const name = text(input.name, "name");
      if (name !== req.headers[APP_HEADER]) throw new HostError(400, "the app named in the body is not the one this request was routed for");
      checkFolder(req, name);
      const by =
        principal.kind === "owner"
          ? { agent: "owner", control: "owner" as const, credential: credentialOf(principal) }
          : (() => {
              const agent = text(input.agent, "agent", "unknown");
              const agentProvenance = provenance(input, agent);
              return { agent, control: "agent-driven" as const, ...(agentProvenance ? { agentProvenance } : {}), credential: credentialOf(principal) };
            })();
      const result = await host.create(name, typeof input.intent === "string" ? input.intent : undefined, by);
      return withCopy(name, result);
    }
    const name = parts[1] ?? "";
    if (!APP_NAME.test(name)) throw new HostError(400, `app name must match ${APP_NAME}`);
    if (name !== req.headers[APP_HEADER]) throw new HostError(400, "this request was routed for another app");
    checkFolder(req, name);
    if (parts.length === 2 && method === "GET") return statusAnswer(name);
    if (parts.length === 3 && method === "GET" && parts[2] === "history") return { history: host.history(name) };
    if (parts.length === 4 && method === "GET" && parts[2] === "undo-plan") {
      // What going back to a version would do, without doing it: what the owner page shows before "Go back".
      const to = parts[3]!;
      if (!/^v\d+$/.test(to)) throw new HostError(400, "to must be a version name, e.g. v3");
      return planAnswer(name, to);
    }
    if (parts.length === 3 && method === "GET" && parts[2] === "folder") return exportWorkingCopy(appRoot(name), name, current(name));
    if (parts.length === 3 && method === "POST") {
      const input = await jsonBody(req);
      if (parts[2] === "changes") {
        checkBase(name, input.base_version);
        const tree = input.tree as { files?: unknown } | undefined;
        if (tree !== undefined) {
          try {
            replaceWorkingTree(appRoot(name), tree?.files);
          } catch (err) {
            throw new HostError(400, `the submitted working tree was not taken: ${err instanceof Error ? err.message : String(err)}`, "bad_tree");
          }
        }
        const owner = principal.kind === "owner";
        // The owner's own change is theirs, whatever environment markers the CLI saw.
        const agent = owner ? "owner" : text(input.agent, "agent", "unknown");
        const agentProvenance = owner ? undefined : provenance(input, agent);
        const result = await host.submit({
          name,
          intent: text(input.intent, "intent"),
          agent,
          ...(agentProvenance ? { agentProvenance } : {}),
          credential: credentialOf(principal),
          byOwner: owner,
          ...(typeof input.one_way === "string" ? { oneWay: input.one_way } : {}),
        });
        const answer = withCopy(name, result);
        await settle(name, result);
        return answer;
      }
      if (parts[2] === "undo") {
        checkBase(name, input.base_version);
        if (input.accept_one_way === true) requireOwner(principal, "Going back past a one-way change");
        if (input.to !== undefined && typeof input.to !== "string") throw new HostError(400, "to must be a version name, e.g. v3");
        if (input.from !== undefined && typeof input.from !== "string") throw new HostError(400, "from must be the version the plan started from, e.g. v5");
        const result = await host.undo(name, text(input.reason, "reason", "undo"), {
          actor: principal.kind === "owner" ? "owner" : text(input.actor, "actor", "unknown"),
          // An agent token's undo is the agent's, not the owner's, whoever ran the CLI.
          control: principal.kind === "owner" ? "owner" : "agent-driven",
          credential: credentialOf(principal),
          ...(typeof input.to === "string" ? { to: input.to.trim() } : {}),
          ...(typeof input.from === "string" ? { from: input.from.trim() } : {}),
          acceptOneWay: input.accept_one_way === true,
          subject: subjectOf(principal),
          ...(principal.kind === "owner" && channelOf(req) ? { channel: channelOf(req) } : {}),
        });
        // Stored data stays as it is; say when the versions gone back past wrote data the older code may not show.
        const record = openRecord(appPaths(appsDir, name));
        const left = result.data_restored ? undefined : dataLeft(result.undone, result.active_version, (version) => record.versionDir(version));
        return withCopy(name, { ...result, ...(left ? { data_left: dataLeftLine(left), data_left_facts: left } : {}) });
      }
      if (parts[2] === "discard") {
        checkBase(name, input.base_version);
        return withCopy(name, await host.discard(name));
      }
    }
    if (parts.length === 5 && method === "POST" && parts[2] === "changes" && parts[4] === "preview") return host.preview(name, parts[3]!);
    if (parts.length === 5 && method === "POST" && parts[2] === "changes" && (parts[4] === "approve" || parts[4] === "deny")) {
      requireOwner(principal, parts[4] === "approve" ? "Approving a change" : "Denying a change");
      const input = await jsonBody(req);
      const result = await host.resolve(name, parts[3]!, parts[4] === "approve" ? "approved" : "denied", subjectOf(principal), typeof input.reason === "string" ? input.reason : undefined, channelOf(req), credentialOf(principal));
      const answer = withCopy(name, result);
      await settle(name, result);
      return answer;
    }
    throw new HostError(404, "not found");
  };

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://host");
    const reply = (status: number, value: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(`${JSON.stringify(value)}\n`);
    if (url.pathname === "/ready" && req.method === "GET") return reply(200, { ready: true, started_at: startedAt, build: opts.build ?? null });
    if (!sameSecret(req.headers[SECRET_HEADER] as string | undefined, secret)) return reply(403, { error: "this port answers the app's Durable Object only", reason: "no_secret" });
    const work = url.pathname.startsWith("/folder/")
      ? folderRoute(req, url).then((answer) => {
          if (!answer) throw new HostError(404, "not found");
          res.writeHead(answer.status, { "content-type": answer.type }).end(answer.body);
        })
      : // Every answer about an app says where the Host's time went: `timing.steps`, in the order they started.
        collectSteps(() => apiRoute(req, url)).then(({ value, steps, ms }) =>
          reply(200, typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value, timing: { host_ms: ms, steps } } : value),
        );
    work.catch((err: unknown) => {
      const status = err instanceof HostError ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      if (status >= 500) log(`${req.method} ${url.pathname} failed: ${message}`);
      const extra = err instanceof HostError ? { ...err.fields, ...(err.reason ? { reason: err.reason } : {}), ...(err.detail ? { detail: err.detail } : {}) } : {};
      if (!res.headersSent) reply(status, { error: message, ...extra });
    });
  });
}
