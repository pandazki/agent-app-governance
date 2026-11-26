import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EDITION, editionHost, TEMPLATE } from "../src/edition";
import { APP_HEADER, CHANNEL_HEADER, folderKey, plansKey, PRINCIPAL_HEADER, SECRET_HEADER, viewKey } from "../src/protocol";
import { appSummaries } from "../worker/apps-index";
import { createContainerServer } from "../src/server";
import { CfSpace } from "../src/space-cf";
import { operate, withTiming, type FolderBucket, type HostPort, type StoredObject } from "../worker/folders";
import { handle, json, OP_HEADER, ORIGIN_HEADER, sha256, type AuthStore, type StoredToken } from "../worker/gateway";
import type { PageDeps } from "../worker/page";
import type { PageModel } from "../../local/src/page-model";
import { assetType } from "../../local/src/page-views";
import { loadPageAssets } from "../../local/src/page";
import { FAKE_TOKEN, FakePlane } from "./fake-plane";

// The whole edition on one machine, without Cloudflare: the Worker's gateway (worker/gateway.ts) on a local port,
// each app's Durable Object as a queue that runs worker/folders.ts, R2 as a map with etags and conditional writes,
// the container as the real container server around the real Host, and PneumaSpace as the fake plane.

/** R2, as much as the edition uses: etags, and puts that hold only under their condition. */
export class MemoryBucket implements FolderBucket {
  readonly objects = new Map<string, { etag: string; bytes: Uint8Array }>();
  /** Runs once, between the next get and the put after it: another writer. */
  interloper: (() => void) | null = null;
  private armed = false;

  async get(key: string): Promise<StoredObject | null> {
    const found = this.objects.get(key);
    if (this.interloper) this.armed = true;
    return found ? { etag: found.etag, bytes: async () => found.bytes.slice().buffer } : null;
  }

  async put(key: string, value: ArrayBuffer | string, condition?: { etagMatches?: string; etagDoesNotMatch?: string }): Promise<{ etag: string } | null> {
    if (this.armed && this.interloper && key.startsWith("folders/")) {
      const run = this.interloper;
      this.interloper = null;
      this.armed = false;
      run();
    }
    const now = this.objects.get(key);
    if (condition?.etagMatches !== undefined && now?.etag !== condition.etagMatches) return null;
    if (condition?.etagDoesNotMatch === "*" && now) return null;
    const etag = randomBytes(8).toString("hex");
    this.objects.set(key, { etag, bytes: typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value) });
    return { etag };
  }

  async list(prefix: string): Promise<{ key: string; etag: string }[]> {
    return [...this.objects.entries()].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, value]) => ({ key, etag: value.etag }));
  }

  write(key: string, bytes: Uint8Array): void {
    this.objects.set(key, { etag: randomBytes(8).toString("hex"), bytes });
  }
}

export class MemoryAuth implements AuthStore {
  readonly sessions = new Map<string, number>();
  readonly tokens = new Map<string, StoredToken>();
  readonly failures = new Map<string, { slot: number; count: number }>();
  async addSession(hash: string, expiresAt: number) {
    this.sessions.set(hash, expiresAt);
  }
  async hasSession(hash: string, now: number) {
    return (this.sessions.get(hash) ?? 0) > now;
  }
  async dropSession(hash: string) {
    this.sessions.delete(hash);
  }
  async addToken(hash: string, token: StoredToken) {
    this.tokens.set(hash, token);
  }
  async findToken(hash: string, now: number) {
    const token = this.tokens.get(hash);
    return token && token.revoked_at === null && token.expires_at > now ? token : null;
  }
  async listTokens() {
    return [...this.tokens.values()];
  }
  async revokeToken(id: string, now: number) {
    for (const [hash, token] of this.tokens) if (token.id === id) return (this.tokens.set(hash, { ...token, revoked_at: token.revoked_at ?? now }), true);
    return false;
  }
  async loginFailures(key: string, now: number, failed: boolean) {
    const slot = Math.floor(now / 600_000);
    const kept = this.failures.get(key);
    const count = kept && kept.slot === slot ? kept.count : 0;
    if (failed) this.failures.set(key, { slot, count: count + 1 });
    return failed ? count + 1 : count;
  }
}

interface Container {
  url: string;
  appsDir: string;
  close(): Promise<void>;
}

export interface Stack {
  url: string;
  /** With StackOptions.domain: the Worker's other address, which is not the Host's own. */
  otherUrl?: string;
  /** Operations the apps' Durable Objects ran, by kind (create, read, write, view, warm), in order. */
  operations: string[];
  ownerKey: string;
  plane: FakePlane;
  bucket: MemoryBucket;
  auth: MemoryAuth;
  /** How many containers were started so far. */
  starts(): number;
  /** Throw the container away, disk and all, as Cloudflare may at any time. */
  dropContainer(): Promise<void>;
  /** A read of the Host in the app's container, as the owner, past the Worker: what the container computes now. */
  containerRead(app: string, path: string): Promise<Response>;
  close(): Promise<void>;
}

/** The model an owner page view carries, from the inert JSON element the shell puts it in. */
export function modelOf(html: string): PageModel {
  const found = /<script type="application\/json" id="model">([\s\S]*?)<\/script>/.exec(html);
  if (!found) throw new Error("no model in the page");
  return JSON.parse(found[1]!) as PageModel;
}

/** The owner page's built client, as the Worker's assets binding serves it: local/web/dist, when it has been built. */
export function pageFromDist(spaceOrigin: string, dir = join(EDITION, "..", "local", "web", "dist")): PageDeps {
  return {
    asset: async (name) => {
      const file = join(dir, name);
      return assetType(name) && existsSync(file) ? new Response(readFileSync(file)) : null;
    },
    versions: async () => loadPageAssets(dir).files,
    spaceOrigin,
    manager: "appgov",
  };
}

export interface StackOptions {
  /** Awaited in the app's Durable Object before each operation: a test or a demo makes one take longer. */
  readonly beforeOperation?: (method: string, path: string, op: string) => Promise<void>;
  /** The Worker's clock; the real one when absent. */
  readonly now?: () => number;
  /** While true, the apps' Durable Objects answer as the build before stored views: they refuse `view` and `warm`. */
  readonly buildBefore?: () => boolean;
  /**
   * The Worker answers at two addresses, as one with the owner's domain does: `url` is the Host's own (its configured
   * address, the domain) and `otherUrl` the one it had before (workers.dev).
   */
  readonly domain?: boolean;
}

export async function startStack(options: StackOptions = {}): Promise<Stack> {
  const plane = new FakePlane();
  const bucket = new MemoryBucket();
  const auth = new MemoryAuth();
  const secret = randomBytes(16).toString("hex");
  const ownerKey = `apk_${randomBytes(32).toString("hex")}`;
  const ownerKeyHash = await sha256(ownerKey);
  let container: Container | null = null;
  let started = 0;
  const queues = new Map<string, Promise<unknown>>();
  const operations: string[] = [];

  const startContainer = async (origin: string): Promise<Container> => {
    const appsDir = mkdtempSync(join(tmpdir(), "appgov-cf-container-"));
    const host = editionHost({
      appsDir,
      space: new CfSpace({ origin: plane.origin, token: FAKE_TOKEN, template: TEMPLATE, fetch: plane.fetch }),
      owner: "user:owner",
      governance: "personal",
      manager: { name: "appgov", url: `${origin}/` },
      previewTtlSeconds: 600,
    });
    const server = createContainerServer({ host, appsDir, secret, ownerSubject: "user:owner" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    started++;
    return {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      appsDir,
      close: async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeAllConnections?.();
        rmSync(appsDir, { recursive: true, force: true });
      },
    };
  };

  // One app's Durable Object: one operation at a time, the container started on demand.
  const serve = async (request: Request): Promise<Response> => {
    const op = request.headers.get(OP_HEADER) ?? "";
    const app = request.headers.get(APP_HEADER) ?? "";
    if (op === "container") {
      if (request.method === "POST") {
        const was = container !== null;
        await dropContainer();
        return json({ app, stopped: was, running: false });
      }
      return json({ app, running: container !== null });
    }
    operations.push(op);
    if (options.buildBefore?.() && (op === "view" || op === "warm" || op === "plan")) return json({ error: "unknown operation", reason: "bad_op" }, 400);
    await options.beforeOperation?.(request.method, new URL(request.url).pathname, op);
    const timing: Record<string, number> = {};
    const began = Date.now();
    container ??= await startContainer(request.headers.get(ORIGIN_HEADER) ?? "");
    timing.container = Date.now() - began;
    const at = container.url;
    const port: HostPort = {
      fetch: (path, init) => fetch(`${at}${path}`, { method: init.method, headers: { ...(init.headers ?? {}), [SECRET_HEADER]: secret }, ...(init.body !== undefined ? { body: init.body } : {}) }),
    };
    const headers: Record<string, string> = {};
    for (const name of [PRINCIPAL_HEADER, APP_HEADER, CHANNEL_HEADER]) {
      const value = request.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    const body = request.method === "POST" ? await request.text() : undefined;
    const res = await operate(bucket, port, { app, op: op as "create" | "read" | "write" | "view" | "warm" | "plan", method: request.method, path: new URL(request.url).pathname, headers, ...(body !== undefined ? { body } : {}) }, timing);
    return withTiming(res, timing);
  };

  const dropContainer = async () => {
    const was = container;
    container = null;
    await was?.close();
  };

  const queued = (name: string, req: Request): Promise<Response> => {
    const run = (queues.get(name) ?? Promise.resolve()).then(() => serve(req));
    queues.set(name, run.catch(() => {}));
    return run;
  };

  let hostUrl: string | undefined;
  const gatewayFetch = (request: Request) =>
      handle(request, {
        starter: { cli: readFileSync(join(EDITION, "bin", "appgov.mjs"), "utf8"), agents: readFileSync(join(EDITION, "overlay", "AGENTS.start.md"), "utf8") },
        page: pageFromDist(plane.origin),
        ownerKeyHash,
        auth,
        governance: "personal",
        app: (name) => ({ fetch: (req) => queued(name, req) }),
        summaries: (steps) => appSummaries(bucket, (work) => void work.catch(() => {}), steps),
        views: {
          view: async (app) => {
            const found = bucket.objects.get(viewKey(app));
            return found ? JSON.parse(new TextDecoder().decode(found.bytes)) : null;
          },
          plans: async (app) => {
            const found = bucket.objects.get(plansKey(app));
            return found ? JSON.parse(new TextDecoder().decode(found.bytes)) : null;
          },
          folderEtag: async (app) => bucket.objects.get(folderKey(app))?.etag ?? null,
        },
        waitUntil: (work) => void work.catch(() => {}),
        ...(options.now ? { now: options.now } : {}),
        ...(hostUrl ? { hostUrl } : {}),
      });
  const gateway = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: gatewayFetch });
  const domain = options.domain ? Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: gatewayFetch }) : null;
  if (domain) hostUrl = `http://127.0.0.1:${domain.port}`;

  return {
    url: hostUrl ?? `http://127.0.0.1:${gateway.port}`,
    ...(domain ? { otherUrl: `http://127.0.0.1:${gateway.port}` } : {}),
    operations,
    ownerKey,
    plane,
    bucket,
    auth,
    starts: () => started,
    dropContainer,
    containerRead: (app, path) =>
      queued(app, new Request(`https://app${path}`, { headers: { [OP_HEADER]: "read", [APP_HEADER]: app, [PRINCIPAL_HEADER]: JSON.stringify({ kind: "owner" }), "content-type": "application/json" } })),
    close: async () => {
      await dropContainer();
      gateway.stop(true);
      domain?.stop(true);
    },
  };
}
