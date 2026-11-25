import { createHash } from "node:crypto";

// A stand-in for PneumaSpace's Cloudflare plane (/api/v1), as much of it as CfSpace uses, with the rules that
// matter to the Host: names are unique, a managed app takes named operations only with the manager's header,
// ephemeral must match on upload and release, the tenant's ephemeral quota, and app answers that carry a
// Server-Timing span while the plane's own refusals do not. Every call is kept in `calls`.

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
  maxTtl = 3600;
  /** When set, every app answers with this status and no app span (as a plane that refuses would). */
  refuseApps = false;
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
    if (match) return this.serve(match[1]!, match[2]!);
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
    return { ...this.listed(app), current: current ? { number: current.number, digest: current.digest } : null, releases: app.releases.map(({ number, digest }) => ({ number, digest })) };
  }

  private needsManager(app: FakeApp, manager: string | null): Response | null {
    if (app.manager && manager !== app.manager.name) return this.error(409, "managed", `${app.manager.name} manages this application.`);
    return null;
  }

  private api(method: string, parts: string[], body: Record<string, unknown>, manager: string | null): Response {
    if (method === "GET" && parts[0] === "me") return Response.json({ tenants: [{ id: "t1", quota: { ephemeral: this.ephemeralQuota } }] });
    if (parts[0] === "tenants" && parts[2] === "apps") {
      if (method === "GET") return Response.json({ items: this.live().map((app) => this.listed(app)) });
      const name = String(body.name);
      if (this.live().some((app) => app.name === name)) return this.error(409, "name", "Name taken.");
      const ephemeral = body.ephemeral as { ttlSeconds?: number } | undefined;
      if (ephemeral) {
        const ttl = ephemeral.ttlSeconds;
        if (typeof ttl !== "number" || ttl < 1 || ttl > this.maxTtl) return this.error(400, "ttl", `ttlSeconds must be a whole number from 1 to ${this.maxTtl}.`);
        if (this.live().filter((app) => app.expiresAt !== null && app.status !== "purging").length >= this.ephemeralQuota) {
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

  private serve(name: string, path: string): Response {
    const app = this.live().find((a) => a.name === name && a.status === "registered");
    if (this.refuseApps || !app) return this.error(app ? 503 : 404, "app", "Application is not active.");
    const release = app.releases.find((r) => r.number === app.current)!;
    app.awake = true;
    if (path === "" && release.files["public/index.html"] !== undefined) return new Response(release.files["public/index.html"], { headers: { "content-type": "text/html", "server-timing": "static;dur=1" } });
    return Response.json({ error: "Not found" }, { status: 404, headers: { "server-timing": "app;dur=3" } });
  }

  /** The files the app named `name` serves now. */
  serving(name: string): Record<string, string> | null {
    const app = this.live().find((a) => a.name === name && a.status === "registered" && a.expiresAt === null);
    return app ? app.releases.find((r) => r.number === app.current)!.files : null;
  }
}
