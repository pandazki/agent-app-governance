import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import {
  MANAGER_HEADER,
  type CommandResult,
  type ProbeResult,
  type PublishOptions,
  type PublishResult,
  type SpaceApp,
  type SpaceRuntime,
  type SpaceState,
} from "../../host/src/space";

// ---------------------------------------------------------------------------
// PneumaSpace's Cloudflare plane as the runtime of the Host.
//
// The same seam as the local edition's `Space` (host/src/space.ts), a second
// implementation: where that one shells out to `appctl` and calls the Node
// gateway's admin API, this one calls the plane's /api/v1 with a scoped token.
// The plane's shape differs (ADR 0046 there): an app is created first, then a
// package is uploaded on a ticket and released; apps are addressed by id; and
// ending or rolling back is a typed action. Apps follow contract
// pneuma-space.cf/1: the package is pneuma-space.json plus the files under app/.
// ---------------------------------------------------------------------------

export interface CfSpaceOptions {
  /** The plane's origin, e.g. https://appgov.vibecoding.icu. */
  readonly origin: string;
  /** A token of the plane with the scopes read, publish, invoke, manage and remove. */
  readonly token: string;
  /** The app template `init` copies. */
  readonly template: string;
  /** The tenant to work in; by default the token's own. */
  readonly tenant?: string;
  /** For tests. */
  readonly fetch?: typeof fetch;
  /** How long one probe waits for the app to answer, in ms. A cold wake takes seconds. */
  readonly probeTimeoutMs?: number;
}

/** A package as the plane takes it: the manifest and every file under app/, base64. */
export interface CfPackage {
  readonly manifest: Record<string, unknown>;
  readonly files: readonly { readonly path: string; readonly body: string; readonly contentType: string }[];
}

const PACKAGE_LIMIT = 4 * 1024 * 1024;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

/**
 * The package for an app directory, as the plane's own CLI builds it: the manifest from pneuma-space.json and every
 * file under app/, sorted, so that the same content always gives the same digest. Dot files and node_modules are
 * left out, a symbolic link is refused.
 */
export function packageApp(dir: string): { pkg: CfPackage; bytes: Buffer; digest: string } {
  const manifest = JSON.parse(readFileSync(join(dir, "pneuma-space.json"), "utf8")) as Record<string, unknown>;
  const root = join(dir, "app");
  if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new Error("the app has no app/ directory, which holds what the plane runs");
  const files: { path: string; body: string; contentType: string }[] = [];
  const walk = (at: string, prefix: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = `${prefix}${entry.name}`;
      const full = join(at, entry.name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`app/${path} is a symbolic link; a package holds plain files only`);
      if (stat.isDirectory()) walk(full, `${path}/`);
      else if (stat.isFile()) files.push({ path, body: readFileSync(full).toString("base64"), contentType: MIME[extname(path).toLowerCase()] ?? "application/octet-stream" });
    }
  };
  walk(root, "");
  if (!files.length || files.length > 256) throw new Error(`app/ holds ${files.length} files; a package holds 1 to 256`);
  const pkg: CfPackage = { manifest, files };
  const bytes = Buffer.from(JSON.stringify(pkg));
  if (bytes.length > PACKAGE_LIMIT) throw new Error(`the package is ${bytes.length} bytes; the plane takes at most ${PACKAGE_LIMIT}`);
  return { pkg, bytes, digest: createHash("sha256").update(bytes).digest("hex") };
}

/** An app as the plane lists it. */
interface Listed {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly expiresAt: number | null;
  readonly manager: { readonly name: string; readonly url: string | null } | null;
}

/** The plane's authoritative detail of one app (GET /apps/:id). */
interface Detail extends Listed {
  readonly current: { readonly number: number; readonly digest: string } | null;
  readonly releases: readonly { readonly number: number; readonly digest: string }[];
}

class PlaneError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message} (${status})`);
  }
}

export class CfSpace implements SpaceRuntime {
  private readonly origin: string;
  private readonly fetcher: typeof fetch;
  private tenantId: string | undefined;
  /** Apps this process published as ephemeral, by name: a probe of one puts it to sleep again (see `probe`). */
  private readonly ephemeral = new Set<string>();

  constructor(private readonly opts: CfSpaceOptions) {
    this.origin = new URL(opts.origin).origin;
    this.fetcher = opts.fetch ?? fetch;
    this.tenantId = opts.tenant;
  }

  private async api<T>(method: string, path: string, body?: unknown, manager?: string): Promise<T> {
    const res = await this.fetcher(`${this.origin}/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.opts.token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        ...(manager ? { [MANAGER_HEADER]: manager } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(180_000),
    });
    const text = await res.text();
    let value: unknown = null;
    try {
      value = text ? JSON.parse(text) : null;
    } catch {}
    if (!res.ok) {
      const error = (value as { error?: { code?: string; message?: string } } | null)?.error;
      throw new PlaneError(res.status, error?.code ?? "error", error?.message ?? (text.slice(0, 200) || res.statusText));
    }
    return value as T;
  }

  private async tenant(): Promise<string> {
    if (this.tenantId) return this.tenantId;
    const me = await this.api<{ tenants: { id: string }[] }>("GET", "/me");
    const id = me.tenants[0]?.id;
    if (!id) throw new Error("the PneumaSpace token belongs to no tenant");
    this.tenantId = id;
    return id;
  }

  private async list(): Promise<Listed[]> {
    return (await this.api<{ items: Listed[] }>("GET", `/tenants/${await this.tenant()}/apps`)).items;
  }

  private async detail(id: string): Promise<Detail | null> {
    try {
      return await this.api<Detail>("GET", `/apps/${encodeURIComponent(id)}`);
    } catch (err) {
      if (err instanceof PlaneError && err.status === 404) return null;
      throw err;
    }
  }

  /** The app under `name` as the plane holds it now: found in the listing, read from its authoritative detail. */
  private async find(name: string): Promise<Detail | null> {
    const listed = (await this.list()).find((app) => app.name === name);
    return listed ? this.detail(listed.id) : null;
  }

  init(dir: string): Promise<CommandResult> {
    try {
      cpSync(this.opts.template, dir, { recursive: true });
      return Promise.resolve({ code: 0, output: `copied the app template into ${dir}` });
    } catch (err) {
      return Promise.resolve({ code: 1, output: err instanceof Error ? err.message : String(err) });
    }
  }

  async app(name: string): Promise<SpaceApp | null> {
    const found = await this.find(name);
    if (!found) return null;
    return { name, status: found.status, expiresAt: found.expiresAt ?? null, manager: found.manager ? { name: found.manager.name, url: found.manager.url ?? null } : null };
  }

  async publish(name: string, dir: string, options: PublishOptions = {}): Promise<PublishResult> {
    const { ephemeral, manager } = options;
    try {
      const { pkg, bytes, digest } = packageApp(dir);
      let app = await this.find(name);
      if (!app) {
        const created = await this.api<Listed>(
          "POST",
          `/tenants/${await this.tenant()}/apps`,
          { name, ...(ephemeral ? { ephemeral: { ttlSeconds: ephemeral.ttlSeconds } } : {}), ...(manager ? { manager: { name: manager.name, ...(manager.url ? { url: manager.url } : {}) } } : {}) },
          manager?.name,
        );
        app = await this.detail(created.id);
        if (!app) throw new Error(`PneumaSpace created ${name} and then did not find it`);
      }
      if (ephemeral) this.ephemeral.add(name);
      const kind = ephemeral ? { ephemeral: true } : {};
      // A durable app that already has a release with these exact bytes goes back to it with the typed action
      // `rollback`, which uploads nothing. Undo and putting the address back take this path.
      const sameManager = !manager || app.manager?.name === manager.name;
      if (!ephemeral && sameManager && app.status === "registered" && app.current?.digest === digest) {
        return { code: 0, output: `${name} already serves these exact files as release ${app.current.number}`, app: app.id };
      }
      const earlier = !ephemeral && sameManager ? [...app.releases].reverse().find((release) => release.digest === digest) : undefined;
      if (earlier && app.status === "registered") {
        const after = await this.api<Detail>("POST", `/apps/${app.id}/actions`, { type: "rollback", release: earlier.number }, manager?.name);
        return { code: 0, output: `${name} went back to release ${earlier.number}, which holds these exact files, as release ${after.current?.number ?? "?"}`, app: app.id };
      }
      const ticket = await this.api<{ uploadId: string; url: string; headers: Record<string, string> }>(
        "POST",
        `/apps/${app.id}/uploads`,
        { manifest: pkg.manifest, digest, bytes: bytes.length, ...kind },
        manager?.name,
      );
      const put = await this.fetcher(ticket.url, { method: "PUT", headers: ticket.headers, body: new Uint8Array(bytes), redirect: "error", signal: AbortSignal.timeout(120_000) });
      if (!put.ok) throw new Error(`the package upload answered ${put.status}`);
      await put.body?.cancel();
      const released = await this.api<Detail>(
        "POST",
        `/apps/${app.id}/releases`,
        { uploadId: ticket.uploadId, ...kind, ...(manager ? { manager: { name: manager.name, ...(manager.url ? { url: manager.url } : {}) } } : {}) },
        manager?.name,
      );
      const ends = released.expiresAt ? ` expires ${new Date(released.expiresAt).toISOString()}  app ${app.id}` : "";
      return { code: 0, output: `released ${name} as release ${released.current?.number ?? "?"}${ends}`, app: app.id };
    } catch (err) {
      return { code: 1, output: await this.refusal(err) };
    }
  }

  /**
   * A publish the plane refused, in the words the Host's previews read (host/src/preview.ts): the tenant's ephemeral
   * quota as a `quota {...}` line, a ttl above the plane's maximum in the gateway's phrasing. Anything else as it came.
   */
  private async refusal(err: unknown): Promise<string> {
    if (!(err instanceof PlaneError)) return err instanceof Error ? err.message : String(err);
    if (err.code === "ephemeral_quota") {
      let used: number | string = "all";
      let limit: number | string = "the tenant's limit";
      try {
        const me = await this.api<{ tenants: { id: string; quota?: { ephemeral?: number } }[] }>("GET", "/me");
        limit = me.tenants.find((t) => t.id === this.tenantId)?.quota?.ephemeral ?? limit;
        used = (await this.list()).filter((app) => app.expiresAt !== null && app.status !== "purging").length;
      } catch {}
      return `${err.message}\nquota ${JSON.stringify({ resource: "ephemeral", used, limit })}`;
    }
    const max = err.code === "ttl" ? /from 1 to (\d+)/.exec(err.message)?.[1] : undefined;
    if (max) return `${err.message}\nephemeral ttl_seconds must be a whole number from 1 to ${max}`;
    return err.message;
  }

  /**
   * Whether the app answers. Two requests, as a signed-in visitor would make them with the token: the home page, which
   * the plane may serve from storage without starting Node, then a path that is no static file, which wakes the Node
   * process. Each must be answered by the app (the plane marks those answers with a `static` or `app` span in
   * Server-Timing) with a status below 500; a refusal by the plane itself (not signed in, app inactive) is not an
   * answer. A preview this process published is put to sleep again afterwards, so that a change waiting for the owner
   * does not hold one of the tenant's few awake slots; opening it wakes it.
   */
  async probe(name: string): Promise<ProbeResult> {
    let first: ProbeResult | undefined;
    for (const path of ["", "appgov-probe"]) {
      const url = `${this.origin}/apps/${name}/${path}`;
      let result: ProbeResult;
      try {
        const res = await this.fetcher(url, {
          headers: { authorization: `Bearer ${this.opts.token}`, accept: "text/html" },
          redirect: "manual",
          signal: AbortSignal.timeout(this.opts.probeTimeoutMs ?? 90_000),
        });
        const timing = res.headers.get("server-timing") ?? "";
        const byApp = /(^|,)\s*(static|app)\b/.test(timing);
        const text = res.status >= 500 || !byApp ? (await res.text()).slice(0, 400) : (await res.body?.cancel(), "");
        result = byApp
          ? { ok: res.status < 500, status: res.status, detail: text }
          : { ok: false, status: res.status, detail: `PneumaSpace answered for the app, not the app itself: ${text}` };
      } catch (err) {
        result = { ok: false, status: 0, detail: err instanceof Error ? err.message : String(err) };
      }
      first ??= result;
      if (!result.ok) {
        first = { ...result, detail: `GET /apps/${name}/${path}: ${result.detail}` };
        break;
      }
    }
    if (this.ephemeral.has(name)) {
      try {
        const found = (await this.list()).find((app) => app.name === name);
        if (found) await this.api("POST", `/apps/${found.id}/actions`, { type: "sleep" });
      } catch {}
    }
    return first!;
  }

  async discard(name: string, manager?: string, app?: string): Promise<boolean> {
    try {
      const id = app ?? (await this.list()).find((listed) => listed.name === name)?.id;
      if (!id) return true;
      await this.api("POST", `/apps/${encodeURIComponent(id)}/actions`, { type: "discard" }, manager);
      this.ephemeral.delete(name);
      return true;
    } catch (err) {
      return err instanceof PlaneError && err.status === 404;
    }
  }

  /**
   * Take a durable app's address down. The plane's tokens cannot purge, so the app is removed (its address answers
   * 404, its data is kept) and stays listed until the owner purges it in the PneumaSpace console; the name stays
   * taken until then, so this resolves to false unless there was no such app.
   */
  async takeDown(name: string, manager?: string): Promise<boolean> {
    try {
      const found = (await this.list()).find((listed) => listed.name === name);
      if (!found) return true;
      await this.api("POST", `/apps/${found.id}/actions`, { type: "remove" }, manager);
      return false;
    } catch (err) {
      return err instanceof PlaneError && err.status === 404;
    }
  }

  async state(name: string): Promise<SpaceState> {
    const found = await this.find(name);
    if (!found) throw new Error(`PneumaSpace has no app named ${name}`);
    await this.api("GET", `/apps/${found.id}/state`);
    // The plane's native services have no engine or volume to name; the Host's data snapshots do not apply here.
    return { app: name, release: found.current?.number ?? null, bundle: found.current?.digest ?? null, bindings: [] };
  }

  async stop(name: string): Promise<void> {
    const found = (await this.list()).find((listed) => listed.name === name);
    if (!found) throw new Error(`PneumaSpace has no app named ${name}`);
    await this.api("POST", `/apps/${found.id}/actions`, { type: "sleep" });
  }

  address(name: string): string {
    return `${this.origin}/apps/${name}/`;
  }
}
