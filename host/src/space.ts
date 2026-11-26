import { boundedText, previewUrl, PREVIEW_REQUEST_LIMITS, type SendToPreview } from "./preview-requests";
import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// PneumaSpace as the runtime of a Creation Host.
//
// The Host owns this effect; the framework never imports it. Publishing goes
// through PneumaSpace's own CLI (`appctl`), so the bundle rules (what ships,
// production dependencies, deterministic tar) stay the platform's. Reads,
// stopping an instance and removal use the admin API directly.
// ---------------------------------------------------------------------------

export interface CommandResult {
  readonly code: number;
  readonly output: string;
}

export function runCommand(
  cmd: readonly string[],
  opts: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const [bin, ...args] = cmd;
    const child = spawn(bin!, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs ?? 300_000);
    // Decoded as a stream: a multi-byte character split across two reads must not become U+FFFD.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (output += chunk));
    child.stderr.on("data", (chunk: string) => (output += chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, output: `${output}\n${err.message}`.trim() });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : (code ?? 1), output: (timedOut ? `${output}\n[timed out]` : output).trim() });
    });
  });
}

export interface ProbeResult {
  readonly ok: boolean;
  readonly status: number;
  readonly detail: string;
}

/** One binding in PneumaSpace's state inventory: where one capability's data lives, without credentials. */
export interface SpaceBinding {
  /** The capability kind, e.g. db, files, kv. */
  readonly kind: string;
  /** The engine behind it, e.g. sqlite or postgres for db. */
  readonly provider: string;
  /** active, or suspended after the app switched engines. */
  readonly state: string;
  /** For postgres: { service: "<host>:<port>", database }. For sqlite and files: { volume }. */
  readonly location: Readonly<Record<string, string>>;
}

/** PneumaSpace's answer on `GET /api/apps/<name>/state`. */
export interface SpaceState {
  readonly app: string;
  readonly release: number | null;
  readonly bundle: string | null;
  readonly bindings: readonly SpaceBinding[];
}

/** Who runs an app's releases from outside PneumaSpace, and where a person acts through it (PneumaSpace ADR 0039). */
export interface SpaceManager {
  /** Matches PneumaSpace's name rule, the same as an app name's. */
  readonly name: string;
  /** An absolute http(s) address; absent keeps the app's current one while the name stays. */
  readonly url?: string | null;
}

/** An app as PneumaSpace lists it: the facts this Host acts on. */
export interface SpaceApp {
  readonly name: string;
  /**
   * `registered`, or `removed` (its address answers 404, its data is kept) or `purging` (it is being ended, and an end
   * that failed stays here until it is retried). PneumaSpace lists an app in every one of them.
   */
  readonly status: string;
  /** When an ephemeral app ends itself, in ms since the epoch; null for a durable app. PneumaSpace ends it within about 10 s of this. */
  readonly expiresAt: number | null;
  /** Null when no manager is set: any write is accepted without naming one. */
  readonly manager: { readonly name: string; readonly url: string | null } | null;
}

/** What a publish printed, and the id of the app it published when appctl printed one (it does for an ephemeral app). */
export interface PublishResult extends CommandResult {
  readonly app?: string;
}

export interface PublishOptions {
  /**
   * Publish an ephemeral app, which ends itself with its data `ttlSeconds` after its first publish.
   * Every later publish of it must say so too, and a durable app refuses it: PneumaSpace answers 409
   * when the two do not match. The ttl is read on the first publish only, and PneumaSpace refuses one
   * above its global `ephemeral_max_ttl_seconds` (3600 by default) rather than shortening it.
   */
  readonly ephemeral?: { readonly ttlSeconds: number };
  /** Names this manager on the write, which a managed app requires, and leaves it as the app's manager. */
  readonly manager?: SpaceManager;
}

/** What the governed loop needs from a runtime. `Space` is the real one; tests supply a fake. */
export interface SpaceRuntime {
  /** Copy the platform's app template into an empty directory. */
  init(dir: string): Promise<CommandResult>;
  /** The app PneumaSpace has under this name, published by anyone, or null. Throws when the platform does not answer. */
  app(name: string): Promise<SpaceApp | null>;
  /** Publish a source directory under an app name. Same name keeps all data. */
  publish(name: string, dir: string, options?: PublishOptions): Promise<PublishResult>;
  /**
   * Wake the app and read its root path. Any status below 500 means it booted. `keepAwake`: requests follow (a preview's
   * own, src/preview-requests.ts), so a runtime that puts a preview to sleep after its probe waits for `rest`.
   */
  probe(name: string, options?: { readonly keepAwake?: boolean }): Promise<ProbeResult>;
  /**
   * Make one of a preview's declared requests, as the app's owner, at `path` inside the app. Never follows a redirect and
   * never throws: a request that cannot be made answers status 0 with `error`. Absent where the runtime cannot make them.
   */
  request?: SendToPreview;
  /** After a probe with `keepAwake` and the requests: what the probe would have done after it, such as putting a preview to sleep. */
  rest?(name: string): void;
  /**
   * End an ephemeral app and its data in one call. `manager` names the manager, which a managed app
   * requires. `app` is the id its publish returned: PneumaSpace then ends nothing when the name now
   * belongs to another app. Resolves to whether the platform no longer has that app (one that was never
   * there, or has ended itself, counts as gone); false when it refused, e.g. for a durable app or another
   * app under the name. Never throws.
   */
  discard(name: string, manager?: string, app?: string): Promise<boolean>;
  /**
   * End a durable app: take the address down, then delete the app and its data (remove, then purge).
   * `manager` names the manager on both writes. Resolves like `discard`. Never throws.
   */
  takeDown(name: string, manager?: string): Promise<boolean>;
  /**
   * Take a durable app down and keep it (PneumaSpace's `remove`): its address stops answering, its stored data, its
   * releases and its name stay. `manager` names the manager on the write. Resolves to whether PneumaSpace holds the app
   * removed now; false when it refused, did not answer, or has no such app. Never throws.
   */
  remove(name: string, manager?: string): Promise<boolean>;
  /**
   * Bring a removed app back with the data it kept. `dir` is the version the Host has current: a runtime that brings
   * an app back by publishing it again (the local gateway registers a removed app again on a publish, with its data)
   * publishes it; one with an action for it (the Cloudflare plane's `resume`) leaves it. Resolves like `remove`.
   */
  resume(name: string, options: { readonly dir: string; readonly manager?: SpaceManager }): Promise<boolean>;
  /**
   * A capability, present only where this Host may delete an app's stored data for good: purge a removed app
   * (PneumaSpace's `purge`). The Cloudflare plane gives tokens no purge authority, on purpose, so its runtime has none,
   * and clearing an app there leaves the app removed on PneumaSpace for its owner to purge. Resolves to whether the app
   * is gone from PneumaSpace now. Never throws.
   */
  readonly purge?: (name: string, manager?: string) => Promise<boolean>;
  /** Where each of the app's bindings keeps its data. Throws when the platform has no such app or does not answer. */
  state(name: string): Promise<SpaceState>;
  /**
   * Drain and remove the app's running instance. The next request wakes it again. Throws when the platform refuses.
   * An operation, not a write to the app: PneumaSpace does not ask for the manager's name here.
   */
  stop(name: string): Promise<void>;
  /** The address a person opens. */
  address(name: string): string;
  /**
   * False when a release never draws on what a preview uploaded, so a preview can be discarded while the release
   * goes out. Left out, a release may reuse the preview's bundle, and the preview stays until the release is done.
   */
  readonly releaseUsesPreviewUpload?: boolean;
}

/** The header that names the manager on a write to a managed app (PneumaSpace ADR 0039). Not a credential. */
export const MANAGER_HEADER = "x-pneuma-space-manager";

/** PneumaSpace's rule for app and manager names. */
export const SPACE_NAME = /^[a-z][a-z0-9-]{0,39}$/;

/** The manager name a Host goes by on PneumaSpace when it is given none. */
export const DEFAULT_MANAGER = "appgov";

/** Who manages an app on PneumaSpace, as the Host named `ours` reads PneumaSpace's answer. */
export interface ManagerState {
  /**
   * `this_host`: `ours`. `unmanaged`: nobody; the Host's next release or undo marks it. `other`: another
   * manager; the Host does not write to the app. `absent`: no such app. `unknown`: PneumaSpace did not answer.
   */
  readonly state: "this_host" | "unmanaged" | "other" | "absent" | "unknown";
  readonly name: string | null;
  readonly note: string;
}

/** PneumaSpace's answer about one app: what `SpaceRuntime.app` resolved to, or the error it threw. Never throws. */
export async function askApp(space: SpaceRuntime, app: string): Promise<{ readonly app: SpaceApp | null } | { readonly error: unknown }> {
  try {
    return { app: await space.app(app) };
  } catch (error) {
    return { error };
  }
}

/** Ask PneumaSpace who manages `app`, and say it as `ours` would. Never throws. */
export async function readManager(space: SpaceRuntime, app: string, ours: string): Promise<ManagerState> {
  return managerFrom(await askApp(space, app), app, ours);
}

/** Who manages `app`, from PneumaSpace's answer (`askApp`), said as `ours` would. */
export function managerFrom(answer: { readonly app: SpaceApp | null } | { readonly error: unknown }, app: string, ours: string): ManagerState {
  if ("error" in answer) {
    const err = answer.error;
    return { state: "unknown", name: null, note: `PneumaSpace did not answer (${err instanceof Error ? err.message : String(err)}), so who manages ${app} there is unknown` };
  }
  const listed = answer.app;
  const manager = listed?.manager;
  // An older CLI prints this line as it is: it says the whole fact on its own.
  if (!listed) return { state: "absent", name: null, note: `PneumaSpace has no app named ${app}, so the data it stored is gone with it; a release or undo is refused until the owner publishes it again or clears it` };
  if (!manager) return { state: "unmanaged", name: null, note: `not marked as managed on PneumaSpace; the next release or undo through this Host marks it as managed by ${ours}` };
  if (manager.name === ours) return { state: "this_host", name: ours, note: `managed on PneumaSpace by this Host (${ours}); a write to it there that does not name this Host is refused` };
  return {
    state: "other",
    name: manager.name,
    note:
      `${app} is managed on PneumaSpace by ${manager.name}${manager.url ? ` (${manager.url})` : ""}, not by this Host (${ours}), and this Host does not write to an app another manager runs. ` +
      `If ${manager.name} is this Host under an earlier name, start it with APPGOV_MANAGER=${manager.name}. ` +
      `If ${manager.name} no longer runs ${app}, the owner ends that with \`appctl unmanage ${app} --manager ${manager.name}\`, and the next change through this Host marks ${app} as its own`,
  };
}

export interface SpaceOptions {
  /** Path to pneuma-space/cli/appctl.ts. */
  readonly cli: string;
  /** Admin API as this process reaches it, e.g. http://gateway:8081. */
  readonly adminUrl: string;
  /** Ingress as this process reaches it, e.g. http://gateway:8080. */
  readonly ingressUrl: string;
  /** Ingress as the user's browser reaches it, e.g. http://127.0.0.1:8080. */
  readonly publicUrl: string;
  /** Owner subject for first publishes, e.g. user:me. */
  readonly owner: string;
  /** Node >= 24 binary that runs appctl. */
  readonly node?: string;
  readonly token?: string;
}

export class Space implements SpaceRuntime {
  constructor(private readonly opts: SpaceOptions) {}

  private appctl(args: readonly string[], timeoutMs = 300_000): Promise<CommandResult> {
    return runCommand([this.opts.node ?? "node", "--disable-warning=ExperimentalWarning", this.opts.cli, ...args], {
      env: { PNEUMA_SPACE_ADMIN: this.opts.adminUrl, PNEUMA_SPACE_OWNER: this.opts.owner, PNEUMA_SPACE_TOKEN: this.opts.token },
      timeoutMs,
    });
  }

  private async admin(method: string, path: string, manager?: string, timeoutMs = 30_000): Promise<Response> {
    return fetch(`${this.opts.adminUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers: { ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}), ...(manager ? { [MANAGER_HEADER]: manager } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  init(dir: string): Promise<CommandResult> {
    return this.appctl(["init", dir], 30_000);
  }

  async app(name: string): Promise<SpaceApp | null> {
    const res = await this.admin("GET", "/api/apps");
    if (!res.ok) throw new Error(`PneumaSpace admin answered ${res.status} to GET /api/apps`);
    const apps = (await res.json()) as { name?: string; status?: string; expiresAt?: number | null; manager?: { name: string; url?: string | null } | null }[];
    const found = apps.find((app) => app.name === name);
    if (!found) return null;
    // A PneumaSpace from before ADRs 0038 and 0039 sends neither field: a durable app nobody manages.
    return {
      name,
      status: String(found.status ?? ""),
      expiresAt: typeof found.expiresAt === "number" ? found.expiresAt : null,
      manager: found.manager ? { name: found.manager.name, url: found.manager.url ?? null } : null,
    };
  }

  async publish(name: string, dir: string, options: PublishOptions = {}): Promise<PublishResult> {
    const { ephemeral, manager } = options;
    const result = await this.appctl([
      "publish",
      name,
      dir,
      "--owner",
      this.opts.owner,
      ...(ephemeral ? ["--ephemeral", "--ttl", String(ephemeral.ttlSeconds)] : []),
      // appctl sends --manager as the header on the write and as the manager the publish leaves.
      ...(manager ? ["--manager", manager.name, ...(manager.url ? ["--manager-url", manager.url] : [])] : []),
    ]);
    // appctl ends an ephemeral app's line with "expires <when>  app <id>".
    const app = result.code === 0 ? /\bexpires \S+ +app (\S+)\s*$/m.exec(result.output)?.[1] : undefined;
    return app ? { ...result, app } : result;
  }

  /**
   * The local gateway's sign-in has no password: whoever names a user is that user (PneumaSpace's local identity). The
   * requests go as the apps' owner, the subject this Host creates apps for, as on the Cloudflare edition, where the
   * platform token the Host holds is the owner's; another subject signs in as appgov-preview. The session stays in memory.
   */
  private async session(app: string): Promise<string | { error: string }> {
    const name = /^user:([a-z0-9_-]{1,32})$/.exec(this.opts.owner)?.[1] ?? "appgov-preview";
    try {
      const res = await fetch(`${this.opts.ingressUrl.replace(/\/$/, "")}/_pneuma-space/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ name, next: `/apps/${app}/` }).toString(),
        redirect: "manual",
        signal: AbortSignal.timeout(PREVIEW_REQUEST_LIMITS.eachMs),
      });
      await res.body?.cancel();
      const cookie = /(?:^|,\s*)(pneuma_space_session=[^;,\s]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
      return cookie ?? { error: `the local gateway's sign-in answered ${res.status} without a session` };
    } catch (err) {
      return { error: `the local gateway's sign-in did not answer (${err instanceof Error ? err.message : String(err)})` };
    }
  }

  private readonly sessions = new Map<string, Promise<string | { error: string }>>();

  readonly request: SendToPreview = async (app, request) => {
    const url = previewUrl(this.opts.ingressUrl, app, request.path);
    if (!url) return { status: 0, body: "", error: `the path ${JSON.stringify(request.path)} leaves the app` };
    let session = this.sessions.get(app);
    if (!session) this.sessions.set(app, (session = this.session(app)));
    const cookie = await session;
    if (typeof cookie !== "string") {
      this.sessions.delete(app);
      return { status: 0, body: "", error: cookie.error };
    }
    try {
      const res = await fetch(url, {
        method: request.method,
        headers: { cookie, accept: "application/json, text/html;q=0.9, */*;q=0.8", ...(request.body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(request.body !== undefined ? { body: request.body } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(PREVIEW_REQUEST_LIMITS.eachMs),
      });
      return { status: res.status, body: await boundedText(res) };
    } catch (err) {
      return { status: 0, body: "", error: err instanceof Error ? err.message : String(err) };
    }
  };

  rest(name: string): void {
    this.sessions.delete(name);
  }

  async probe(name: string): Promise<ProbeResult> {
    const url = `${this.opts.ingressUrl.replace(/\/$/, "")}/apps/${name}/`;
    try {
      const res = await fetch(url, { headers: { accept: "text/html" }, redirect: "manual", signal: AbortSignal.timeout(30_000) });
      const detail = res.status >= 500 ? (await res.text()).slice(0, 400) : "";
      return { ok: res.status < 500, status: res.status, detail };
    } catch (err) {
      return { ok: false, status: 0, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async discard(name: string, manager?: string, app?: string): Promise<boolean> {
    // 404: no app by that name, e.g. one that has ended itself. The name is free once this answers.
    // 409 with ?app=: the name belongs to another app now, and nothing was ended.
    try {
      const res = await this.admin("POST", `/api/apps/${encodeURIComponent(name)}/discard${app ? `?app=${encodeURIComponent(app)}` : ""}`, manager);
      return res.ok || res.status === 404;
    } catch {
      return false;
    }
  }

  async takeDown(name: string, manager?: string): Promise<boolean> {
    // 404: no app by that name. Purge refuses an app that was not removed first, and only after a
    // purge is the name free again.
    const done = (res: Response) => res.ok || res.status === 404;
    try {
      if (!done(await this.admin("POST", `/api/apps/${encodeURIComponent(name)}/remove`, manager))) return false;
      return done(await this.admin("POST", `/api/apps/${encodeURIComponent(name)}/purge`, manager));
    } catch {
      return false;
    }
  }

  async remove(name: string, manager?: string): Promise<boolean> {
    try {
      // Removing an app that is removed already answers 200 too.
      return (await this.admin("POST", `/api/apps/${encodeURIComponent(name)}/remove`, manager)).ok;
    } catch {
      return false;
    }
  }

  /** The local gateway has no resume: a publish registers a removed app again, with the same id and the data it kept. */
  async resume(name: string, options: { readonly dir: string; readonly manager?: SpaceManager }): Promise<boolean> {
    const published = await this.publish(name, options.dir, options.manager ? { manager: options.manager } : {});
    return published.code === 0;
  }

  /**
   * The admin token may purge here (it already ends what a failed create left). Only a removed app can be purged. The
   * gateway answers once the app's storage is destroyed, which took 36 s on a trial stack with key-value data.
   */
  readonly purge = async (name: string, manager?: string): Promise<boolean> => {
    try {
      const res = await this.admin("POST", `/api/apps/${encodeURIComponent(name)}/purge`, manager, 180_000);
      return res.ok || res.status === 404;
    } catch {
      return false;
    }
  };

  async state(name: string): Promise<SpaceState> {
    const path = `/api/apps/${encodeURIComponent(name)}/state`;
    const res = await this.admin("GET", path);
    if (res.status === 404) throw new Error(`PneumaSpace has no app named ${name}`);
    if (!res.ok) throw new Error(`PneumaSpace admin answered ${res.status} to GET ${path}`);
    return (await res.json()) as SpaceState;
  }

  async stop(name: string): Promise<void> {
    const path = `/api/apps/${encodeURIComponent(name)}/stop`;
    const res = await this.admin("POST", path);
    if (res.status === 404) throw new Error(`PneumaSpace has no app named ${name}`);
    if (!res.ok) throw new Error(`PneumaSpace admin answered ${res.status} to POST ${path}`);
  }

  address(name: string): string {
    return `${this.opts.publicUrl.replace(/\/$/, "")}/apps/${name}/`;
  }
}

export function spaceFromEnv(env: Record<string, string | undefined> = process.env): Space {
  const cli = env.APPGOV_SPACE_CLI;
  if (!cli) throw new Error("APPGOV_SPACE_CLI must point at pneuma-space/cli/appctl.ts");
  const adminUrl = env.APPGOV_SPACE_ADMIN ?? "http://127.0.0.1:8081";
  const ingressUrl = env.APPGOV_SPACE_INGRESS ?? "http://127.0.0.1:8080";
  return new Space({
    cli,
    adminUrl,
    ingressUrl,
    publicUrl: env.APPGOV_SPACE_PUBLIC ?? "http://127.0.0.1:8080",
    owner: env.APPGOV_OWNER ?? "user:me",
    node: env.APPGOV_NODE,
    token: env.APPGOV_SPACE_TOKEN,
  });
}
