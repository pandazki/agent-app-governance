import { createHash } from "node:crypto";

// A stand-in for PneumaSpace's Cloudflare plane (/api/v1), as much of it as CfSpace uses, with the rules that
// matter to the Host: names are unique, a managed app takes named operations only with the manager's header,
// ephemeral must match on upload and release, the tenant's ephemeral quota, the tenant's awake slots (when
// `awakeQuota` is set), and app answers that carry a Server-Timing span while the plane's own refusals do not. Every
// call is kept in `calls`.

export interface FakeApp {
  id: string;
  name: string;
  status: string;
  expiresAt: number | null;
  manager: { name: string; url: string | null } | null;
  releases: { number: number; digest: string; files: Record<string, string> }[];
  current: number | null;
  awake: boolean;
}

export interface FakeCall {
  method: string;
  path: string;
  manager: string | null;
  body: unknown;
}

const TOKEN = "f".repeat(64);
export const FAKE_TOKEN = TOKEN;

export class FakePlane {
  readonly origin = "https://plane.test";
  readonly apps: FakeApp[] = [];
  readonly calls: FakeCall[] = [];
  ephemeralQuota = 3;
  /** Whether the tenant's storage is full: PneumaSpace then refuses a new app with the code it uses for ephemeral apps. */
  storageFull = false;
  maxTtl = 3600;
  /**
   * How many apps may be awake at once, as the tenant's `awake` quota. When set, the plane behaves as the real one does
   * for a Node app: a release puts the app's running instance away and then starts the new one, which needs a slot, and
   * a request to an app that sleeps wakes it, which needs one too; with every slot held both are refused with 503
   * `compute_quota`, and a refused release leaves the app as it was. Unset, nothing counts.
   */
  awakeQuota: number | null = null;
  /** When set, every app answers with this status and no app span (as a plane that refuses would). */
  refuseApps = false;
  /**
   * How a running app answers a request other than its home page, with its own storage (empty for a new app, as a
   * preview's is). Without it, every app answers like the template's starter: /api/items lists the sample entries
   * until a PUT stores others.
   */
  answer: ((app: string, request: { method: string; path: string; body?: string }, store: Map<string, unknown>) => Response | undefined) | null = null;
  /** Each request an app was asked, other than for its home page and the probe's path: "<app> <method> /<path>". */
  readonly appRequests: string[] = [];
  private readonly stores = new Map<string, Map<string, unknown>>();
  private uploads = new Map<string, { app: string; digest: string; bytes: number; ephemeral: boolean; body?: Uint8Array }>();
  private seq = 0;

  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    if (url.pathname.startsWith("/upload/")) return this.put(url.pathname.slice(8), init?.body as Uint8Array);
    if (headers.get("authorization") !== `Bearer ${TOKEN}`) return this.error(401, "auth", "Sign in first.");
    let body: Record<string, unknown> = {};
    if (typeof init?.body === "string" && init.body) body = JSON.parse(init.body);
    const manager = headers.get("x-pneuma-space-manager");
    if (url.pathname.startsWith("/api/v1/")) {
      this.calls.push({ method, path: url.pathname.slice(7), manager, body });
      return this.api(method, url.pathname.slice(7).split("/").filter(Boolean), body, manager);
    }
    const match = /^\/apps\/([a-z][a-z0-9-]*)\/(.*)$/.exec(url.pathname);
    if (match) return this.serve(match[1]!, match[2]!, method, typeof init?.body === "string" ? init.body : undefined);
    return this.error(404, "not_found", "Route not found.");
  }) as typeof fetch;

  private error(status: number, code: string, message: string): Response {
    return Response.json({ error: { code, message } }, { status });
  }

  private live(): FakeApp[] {
    return this.apps.filter((app) => app.status !== "purged");
  }

  private listed(app: FakeApp) {
    return { id: app.id, name: app.name, status: app.status, expiresAt: app.expiresAt, manager: app.manager };
  }

  private detail(app: FakeApp) {
    const current = app.releases.find((r) => r.number === app.current);
    return {
      ...this.listed(app),
      runtime: { state: app.awake ? "awake" : "asleep", running: app.awake },
      current: current ? { number: current.number, digest: current.digest } : null,
      releases: app.releases.map(({ number, digest }) => ({ number, digest })),
    };
  }

  /** Every slot held by another app than `app`: waking `app` is refused. */
  private full(app: FakeApp): boolean {
    return this.awakeQuota !== null && this.live().filter((other) => other.awake && other !== app).length >= this.awakeQuota;
  }

  private needsManager(app: FakeApp, manager: string | null): Response | null {
    if (app.manager && manager !== app.manager.name) return this.error(409, "managed", `${app.manager.name} manages this application.`);
    return null;
  }

  private api(method: string, parts: string[], body: Record<string, unknown>, manager: string | null): Response {
    if (method === "GET" && parts[0] === "me") return Response.json({ tenants: [{ id: "t1", quota: { ephemeral: this.ephemeralQuota, awake: this.awakeQuota ?? 10 } }] });
    if (parts[0] === "tenants" && parts[2] === "apps") {
      if (method === "GET") return Response.json({ items: this.live().map((app) => this.listed(app)) });
      const name = String(body.name);
      if (this.live().some((app) => app.name === name)) return this.error(409, "name", "Name taken.");
      const ephemeral = body.ephemeral as { ttlSeconds?: number } | undefined;
      if (ephemeral) {
        const ttl = ephemeral.ttlSeconds;
        if (typeof ttl !== "number" || ttl < 1 || ttl > this.maxTtl) return this.error(400, "ttl", `ttlSeconds must be a whole number from 1 to ${this.maxTtl}.`);
        if (this.storageFull || this.live().filter((app) => app.expiresAt !== null && app.status !== "purging").length >= this.ephemeralQuota) {
          return this.error(409, "ephemeral_quota", "The space has reached its ephemeral application or allocated storage limit.");
        }
      }
      const m = body.manager as { name: string; url?: string } | undefined;
      const app: FakeApp = {
        id: `a${++this.seq}`,
        name,
        status: "draft",
        expiresAt: ephemeral ? Date.now() + ephemeral.ttlSeconds! * 1000 : null,
        manager: m ? { name: m.name, url: m.url ?? null } : null,
        releases: [],
        current: null,
        awake: false,
      };
      this.apps.push(app);
      return Response.json(this.listed(app), { status: 201 });
    }
    const app = this.live().find((a) => a.id === parts[1]);
    if (parts[0] !== "apps" || !app) return this.error(404, "app", "Application not found.");
    if (parts.length === 2 && method === "GET") return Response.json(this.detail(app));
    if (parts[2] === "uploads") {
      const refused = this.needsManager(app, manager);
      if (refused) return refused;
      if (Boolean(body.ephemeral) !== (app.expiresAt !== null)) return this.error(409, "kind", "ephemeral must match the application.");
      const id = `u${++this.seq}`;
      this.uploads.set(id, { app: app.id, digest: String(body.digest), bytes: Number(body.bytes), ephemeral: Boolean(body.ephemeral) });
      return Response.json({ uploadId: id, url: `${this.origin}/upload/${id}`, headers: { "content-type": "application/json" } }, { status: 201 });
    }
    if (parts[2] === "releases") {
      const refused = this.needsManager(app, manager);
      if (refused) return refused;
      const upload = this.uploads.get(String(body.uploadId));
      if (!upload?.body || upload.app !== app.id) return this.error(409, "upload", "Upload not complete.");
      if (Boolean(body.ephemeral) !== upload.ephemeral) return this.error(409, "kind", "ephemeral must match the upload.");
      const pkg = JSON.parse(new TextDecoder().decode(upload.body)) as { files: { path: string; body: string }[] };
      if (this.awakeQuota !== null) {
        // The running instance is put away first; the new one then needs a slot of its own.
        app.awake = false;
        if (this.full(app)) return this.error(503, "compute_quota", "The space has reached its running application limit.");
        app.awake = true;
      }
      const number = app.releases.length + 1;
      app.releases.push({ number, digest: upload.digest, files: Object.fromEntries(pkg.files.map((f) => [f.path, Buffer.from(f.body, "base64").toString("utf8")])) });
      app.current = number;
      app.status = "registered";
      return Response.json(this.detail(app), { status: 201 });
    }
    if (parts[2] === "actions") {
      const type = String(body.type);
      if (["rollback", "remove", "discard", "policy", "purge", "resume"].includes(type)) {
        const refused = this.needsManager(app, manager);
        if (refused) return refused;
      }
      if (type === "rollback") {
        const release = app.releases.find((r) => r.number === body.release);
        if (!release) return this.error(404, "release", "Release not found.");
        const number = app.releases.length + 1;
        app.releases.push({ ...release, number });
        app.current = number;
      } else if (type === "discard") {
        if (app.expiresAt === null) return this.error(409, "discard", "Only ephemeral applications can be discarded.");
        app.status = "purged";
      } else if (type === "remove") app.status = "removed";
      else if (type === "resume") {
        if (app.status === "removed") app.status = app.current ? "registered" : "draft";
      } else if (type === "purge") return this.error(403, "forbidden", "Tokens cannot purge; the owner purges in the console.");
      else if (type === "sleep") app.awake = false;
      else return this.error(400, "action", "Unknown application action.");
      return Response.json(this.detail(app));
    }
    return this.error(404, "not_found", "Route not found.");
  }

  private put(id: string, body: Uint8Array): Response {
    const upload = this.uploads.get(id);
    if (!upload) return new Response("no ticket", { status: 404 });
    const bytes = new Uint8Array(body);
    if (bytes.length !== upload.bytes || createHash("sha256").update(bytes).digest("hex") !== upload.digest) return new Response("digest", { status: 400 });
    upload.body = bytes;
    return new Response(null, { status: 200 });
  }

  private serve(name: string, path: string, method = "GET", body?: string): Response {
    const app = this.live().find((a) => a.name === name && a.status === "registered");
    if (this.refuseApps || !app) return this.error(app ? 503 : 404, "app", "Application is not active.");
    const release = app.releases.find((r) => r.number === app.current)!;
    if (!app.awake && this.full(app)) return this.error(503, "compute_quota", "The space has reached its running application limit.");
    app.awake = true;
    if (path === "" && release.files["public/index.html"] !== undefined) return new Response(release.files["public/index.html"], { headers: { "content-type": "text/html", "server-timing": "static;dur=1" } });
    if (path !== "" && path !== "appgov-probe") {
      this.appRequests.push(`${name} ${method} /${path}`);
      if (!this.stores.has(app.id)) this.stores.set(app.id, new Map());
      const store = this.stores.get(app.id)!;
      const timing = { "server-timing": "app;dur=2" };
      const answered = this.answer?.(name, { method, path: `/${path}`, ...(body !== undefined ? { body } : {}) }, store);
      if (answered) {
        const headers = new Headers(answered.headers);
        headers.set("server-timing", "app;dur=2");
        return new Response(answered.body, { status: answered.status, headers });
      }
      // As the template's server answers on PneumaSpace: the items with their kv revision (null for the sample), and a
      // save that compares and swaps on it (`expected`), so a stale or invented revision is refused as it is there.
      if (path === "api/items" && method === "GET") {
        return Response.json({ items: store.get("items") ?? [{ id: "first-screen", title: "The one-screen project" }], revision: store.get("revision") ?? null, sample: !store.has("items") }, { headers: timing });
      }
      if (path === "api/items" && method === "PUT") {
        const sent = JSON.parse(body ?? "{}") as { items?: unknown; revision?: unknown };
        if ((store.get("revision") ?? null) !== sent.revision) return Response.json({ error: "Your shelf changed in another tab. Reload before saving." }, { status: 409, headers: timing });
        // One counter per app numbers every key's revisions, so this key's grows, but not by one.
        const revision = ((store.get("counter") as number | undefined) ?? 0) + 2;
        store.set("counter", revision).set("items", sent.items).set("revision", revision);
        return Response.json({ items: sent.items, revision, sample: false }, { headers: timing });
      }
    }
    return Response.json({ error: "Not found" }, { status: 404, headers: { "server-timing": "app;dur=3" } });
  }

  /** What the PneumaSpace owner does in the console behind the Host's back: remove and purge the app, data and all. */
  vanish(name: string): void {
    const app = this.live().find((a) => a.name === name);
    if (app) app.status = "purged";
  }

  /** An app someone else made, outside any Host, as a person publishes with PneumaSpace's own CLI; `awake` as if just opened. */
  outsider(name: string, awake = false): FakeApp {
    const app: FakeApp = { id: `a${++this.seq}`, name, status: "registered", expiresAt: null, manager: null, releases: [{ number: 1, digest: "outside", files: { "public/index.html": "<h1>outside</h1>" } }], current: 1, awake };
    this.apps.push(app);
    return app;
  }

  /** The app named `name` as the plane holds it now, in any status but purged. */
  find(name: string): FakeApp | undefined {
    return this.live().find((a) => a.name === name);
  }

  /** The files the app named `name` serves now. */
  serving(name: string): Record<string, string> | null {
    const app = this.live().find((a) => a.name === name && a.status === "registered" && a.expiresAt === null);
    return app ? app.releases.find((r) => r.number === app.current)!.files : null;
  }
}
