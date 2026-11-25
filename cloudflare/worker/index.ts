import { DurableObject } from "cloudflare:workers";
import { operate, withTiming, type FolderBucket, type HostPort } from "./folders";
import { handle, json, OP_HEADER, ORIGIN_HEADER, type AuthStore, type StoredToken } from "./gateway";
import { APP_HEADER, SECRET_HEADER } from "../src/protocol";
// Bundled as text (the `rules` in wrangler.jsonc): the CLI and the starter instructions this Worker was deployed with.
import starterCli from "../bin/appgov.mjs";
import starterAgents from "../overlay/AGENTS.start.md";

// ---------------------------------------------------------------------------
// The Cloudflare edition's Worker: the gateway in front (worker/gateway.ts),
// one Durable Object per app that owns that app's container and runs its
// operations one at a time (worker/folders.ts), and one Durable Object that
// keeps the owner's sessions and the agent tokens, hashed.
// ---------------------------------------------------------------------------

interface Env {
  APPS: DurableObjectNamespace<AppHostObject>;
  AUTH: DurableObjectNamespace<AuthObject>;
  FOLDERS: R2Bucket;
  /** Which version of this Worker is running here. */
  WORKER_VERSION?: WorkerVersionMetadata;
  /** SHA-256 of the owner key (secret). */
  APPGOV_OWNER_KEY_HASH: string;
  /** Shared with the container (secret). */
  APPGOV_CONTAINER_SECRET: string;
  /** The PneumaSpace token the Host publishes with (secret); passed to the container only. */
  APPGOV_SPACE_TOKEN: string;
  APPGOV_SPACE_ORIGIN: string;
  APPGOV_GOVERNANCE: string;
  APPGOV_MANAGER: string;
  APPGOV_PREVIEW_TTL: string;
  APPGOV_CONTAINER_INSTANCE: string;
  /** Where the app Durable Objects (and so their containers) are placed first, e.g. wnam, near the bucket. */
  APPGOV_LOCATION_HINT?: string;
}

const READY_WAIT_MS = 180_000;
const OPERATION_LIMIT_MS = 20 * 60_000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const auth = env.AUTH.getByName("auth");
    const store: AuthStore = {
      addSession: (hash, expiresAt) => auth.addSession(hash, expiresAt),
      hasSession: (hash, now) => auth.hasSession(hash, now),
      dropSession: (hash) => auth.dropSession(hash),
      addToken: (hash, token) => auth.addToken(hash, token),
      findToken: (hash, now) => auth.findToken(hash, now),
      listTokens: () => auth.listTokens(),
      revokeToken: (id, now) => auth.revokeToken(id, now),
      loginFailures: (key, now, failed) => auth.loginFailures(key, now, failed),
    };
    return handle(request, {
      starter: { cli: starterCli, agents: starterAgents },
      ownerKeyHash: env.APPGOV_OWNER_KEY_HASH,
      auth: store,
      governance: env.APPGOV_GOVERNANCE,
      app: (name) => env.APPS.get(env.APPS.idFromName(name), env.APPGOV_LOCATION_HINT ? { locationHint: env.APPGOV_LOCATION_HINT as DurableObjectLocationHint } : {}),
      summaries: async () => {
        const out: unknown[] = [];
        let cursor: string | undefined;
        do {
          const page = await env.FOLDERS.list({ prefix: "summaries/", cursor });
          for (const object of page.objects) {
            const body = await env.FOLDERS.get(object.key);
            if (body) out.push(await body.json());
          }
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
        return out;
      },
    });
  },
} satisfies ExportedHandler<Env>;

/** One app: its container, its folder in R2, and one operation at a time. */
export class AppHostObject extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();

  override fetch(request: Request): Promise<Response> {
    const run = this.queue.then(() => this.serve(request));
    this.queue = run.catch(() => {});
    return run;
  }

  private port() {
    return this.ctx.container!.getTcpPort(8080);
  }

  /** The container, started and answering. Returns how long that took, 0 when it was already up. */
  private async ensure(origin: string): Promise<number> {
    const container = this.ctx.container!;
    const began = Date.now();
    if (container.running) {
      try {
        const ready = await this.port().fetch("http://host/ready", { signal: AbortSignal.timeout(3000) });
        await ready.body?.cancel();
        if (ready.ok) return 0;
      } catch {}
      try {
        await container.destroy();
      } catch {}
    }
    const image = container.images.host;
    if (!image) throw new Error("the Worker has no container image named host");
    container.start({
      image,
      instance: (this.env.APPGOV_CONTAINER_INSTANCE || "standard-1") as "standard-1",
      enableInternet: true,
      env: {
        APPGOV_CONTAINER_SECRET: this.env.APPGOV_CONTAINER_SECRET,
        APPGOV_SPACE_TOKEN: this.env.APPGOV_SPACE_TOKEN,
        APPGOV_SPACE_ORIGIN: this.env.APPGOV_SPACE_ORIGIN,
        APPGOV_GOVERNANCE: this.env.APPGOV_GOVERNANCE,
        APPGOV_MANAGER: this.env.APPGOV_MANAGER,
        APPGOV_MANAGER_URL: `${origin}/`,
        APPGOV_PREVIEW_TTL: this.env.APPGOV_PREVIEW_TTL,
      },
    });
    await container.setInactivityTimeout(10 * 60_000);
    let last = "";
    for (const deadline = Date.now() + READY_WAIT_MS; Date.now() < deadline; ) {
      try {
        const ready = await this.port().fetch("http://host/ready", { signal: AbortSignal.timeout(2000) });
        await ready.body?.cancel();
        if (ready.ok) return Date.now() - began;
        last = `ready answered ${ready.status}`;
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`the Host's container did not start within ${READY_WAIT_MS / 1000} s (${last})`);
  }

  private async serve(request: Request): Promise<Response> {
    const op = request.headers.get(OP_HEADER) ?? "";
    const app = request.headers.get(APP_HEADER) ?? "";
    const url = new URL(request.url);
    const container = this.ctx.container;
    if (!container) return json({ error: "this Durable Object has no container binding", reason: "no_container" }, 500);
    if (op === "container") {
      if (request.method === "POST") {
        const was = container.running;
        if (was) await container.destroy();
        // This object is restarted too, once the answer is out: an object that stays active keeps the Worker version
        // and the image it started with, so after a redeploy the next request would start the old build again. A
        // restarted object runs the Worker's current version and starts the container from that version's image.
        setTimeout(() => this.ctx.abort("the owner stopped the Host's container; restarting on the current version"), 250);
        return json({ app, stopped: was, running: container.running, restarting: true });
      }
      // Which image the Durable Object starts, by its digest only (the registry path names the account), and which
      // build of the Host answers in the running container.
      const image = (container.images.host ?? "").split("/").at(-1)?.replace(/(@sha256:[a-f0-9]{12})[a-f0-9]+/, "$1") || null;
      let build: unknown = null;
      if (container.running) {
        try {
          build = ((await (await this.port().fetch("http://host/ready", { signal: AbortSignal.timeout(3000) })).json()) as { build?: unknown }).build ?? null;
        } catch {}
      }
      const worker = this.env.WORKER_VERSION ? { version: this.env.WORKER_VERSION.id.slice(0, 8), uploaded: this.env.WORKER_VERSION.timestamp } : null;
      return json({ app, running: container.running, image, build, worker });
    }
    if (op !== "create" && op !== "read" && op !== "write") return json({ error: "unknown operation", reason: "bad_op" }, 400);
    const timing: Record<string, number> = {};
    try {
      timing.container = await this.ensure(request.headers.get(ORIGIN_HEADER) ?? "");
      const secret = this.env.APPGOV_CONTAINER_SECRET;
      const host: HostPort = {
        fetch: (path, init) =>
          this.port().fetch(`http://host${path}`, {
            method: init.method,
            headers: { ...(init.headers ?? {}), [SECRET_HEADER]: secret },
            ...(init.body !== undefined ? { body: init.body } : {}),
            signal: AbortSignal.timeout(OPERATION_LIMIT_MS),
          }),
      };
      const bucket: FolderBucket = {
        get: async (key) => {
          const object = await this.env.FOLDERS.get(key);
          return object ? { etag: object.etag, bytes: () => object.arrayBuffer() } : null;
        },
        put: async (key, value, condition) => {
          const put = await this.env.FOLDERS.put(key, value, condition ? { onlyIf: condition } : {});
          return put ? { etag: put.etag } : null;
        },
      };
      const headers: Record<string, string> = {};
      for (const name of ["x-appgov-principal", APP_HEADER]) {
        const value = request.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      const body = request.method === "POST" ? await request.text() : undefined;
      return await operate(bucket, host, { app, op, method: request.method, path: url.pathname, headers, ...(body !== undefined ? { body } : {}) }, timing);
    } catch (err) {
      return withTiming(json({ error: err instanceof Error ? err.message : String(err), reason: "host_unavailable" }, 502), timing);
    }
  }
}

/** The owner's sessions and the agent tokens, by SHA-256; and failed sign-ins, by caller, for ten minutes. */
export class AuthObject extends DurableObject<Env> {
  private kv() {
    return this.ctx.storage.kv;
  }

  async addSession(hash: string, expiresAt: number): Promise<void> {
    this.kv().put(`session:${hash}`, { expires_at: expiresAt });
  }

  async hasSession(hash: string, now: number): Promise<boolean> {
    const found = this.kv().get<{ expires_at: number }>(`session:${hash}`);
    if (!found) return false;
    if (found.expires_at <= now) {
      this.kv().delete(`session:${hash}`);
      return false;
    }
    return true;
  }

  async dropSession(hash: string): Promise<void> {
    this.kv().delete(`session:${hash}`);
  }

  async addToken(hash: string, token: StoredToken): Promise<void> {
    this.kv().put(`token:${hash}`, token);
    this.kv().put(`token-id:${token.id}`, hash);
  }

  async findToken(hash: string, now: number): Promise<StoredToken | null> {
    const token = this.kv().get<StoredToken>(`token:${hash}`);
    return token && token.revoked_at === null && token.expires_at > now ? token : null;
  }

  async listTokens(): Promise<StoredToken[]> {
    return [...this.kv().list<StoredToken>({ prefix: "token:" })].map(([, token]) => token).sort((a, b) => a.created_at - b.created_at);
  }

  async revokeToken(id: string, now: number): Promise<boolean> {
    const hash = this.kv().get<string>(`token-id:${id}`);
    const token = hash ? this.kv().get<StoredToken>(`token:${hash}`) : undefined;
    if (!hash || !token) return false;
    if (token.revoked_at === null) this.kv().put(`token:${hash}`, { ...token, revoked_at: now });
    return true;
  }

  async loginFailures(key: string, now: number, failed: boolean): Promise<number> {
    const slot = Math.floor(now / 600_000);
    const name = `login:${key}`;
    const kept = this.kv().get<{ slot: number; count: number }>(name);
    const count = kept && kept.slot === slot ? kept.count : 0;
    if (!failed) return count;
    this.kv().put(name, { slot, count: count + 1 });
    return count + 1;
  }
}
