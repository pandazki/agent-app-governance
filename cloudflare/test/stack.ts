import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editionHost, TEMPLATE } from "../src/edition";
import { APP_HEADER, PRINCIPAL_HEADER, SECRET_HEADER } from "../src/protocol";
import { createContainerServer } from "../src/server";
import { CfSpace } from "../src/space-cf";
import { operate, withTiming, type FolderBucket, type HostPort, type StoredObject } from "../worker/folders";
import { handle, json, OP_HEADER, ORIGIN_HEADER, sha256, type AuthStore, type StoredToken } from "../worker/gateway";
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
  ownerKey: string;
  plane: FakePlane;
  bucket: MemoryBucket;
  auth: MemoryAuth;
  /** How many containers were started so far. */
  starts(): number;
  /** Throw the container away, disk and all, as Cloudflare may at any time. */
  dropContainer(): Promise<void>;
  close(): Promise<void>;
}

export async function startStack(): Promise<Stack> {
  const plane = new FakePlane();
  const bucket = new MemoryBucket();
  const auth = new MemoryAuth();
  const secret = randomBytes(16).toString("hex");
  const ownerKey = `apk_${randomBytes(32).toString("hex")}`;
  const ownerKeyHash = await sha256(ownerKey);
  let container: Container | null = null;
  let started = 0;
  const queues = new Map<string, Promise<unknown>>();

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
    const timing: Record<string, number> = {};
    const began = Date.now();
    container ??= await startContainer(request.headers.get(ORIGIN_HEADER) ?? "");
    timing.container = Date.now() - began;
    const at = container.url;
    const port: HostPort = {
      fetch: (path, init) => fetch(`${at}${path}`, { method: init.method, headers: { ...(init.headers ?? {}), [SECRET_HEADER]: secret }, ...(init.body !== undefined ? { body: init.body } : {}) }),
    };
    const headers: Record<string, string> = {};
    for (const name of [PRINCIPAL_HEADER, APP_HEADER]) {
      const value = request.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    const body = request.method === "POST" ? await request.text() : undefined;
    const res = await operate(bucket, port, { app, op: op as "create" | "read" | "write", method: request.method, path: new URL(request.url).pathname, headers, ...(body !== undefined ? { body } : {}) }, timing);
    return withTiming(res, timing);
  };

  const dropContainer = async () => {
    const was = container;
    container = null;
    await was?.close();
  };

  const gateway = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: (request) =>
      handle(request, {
        ownerKeyHash,
        auth,
        governance: "personal",
        app: (name) => ({
          fetch: (req) => {
            const run = (queues.get(name) ?? Promise.resolve()).then(() => serve(req));
            queues.set(name, run.catch(() => {}));
            return run;
          },
        }),
        summaries: async () =>
          [...bucket.objects.entries()].filter(([key]) => key.startsWith("summaries/")).map(([, value]) => JSON.parse(new TextDecoder().decode(value.bytes))),
      }),
  });

  return {
    url: `http://127.0.0.1:${gateway.port}`,
    ownerKey,
    plane,
    bucket,
    auth,
    starts: () => started,
    dropContainer,
    close: async () => {
      await dropContainer();
      gateway.stop(true);
    },
  };
}
