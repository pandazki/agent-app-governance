import { DurableObject } from "cloudflare:workers";
import { planeListing, RUNTIME_KEY } from "./runtime-check";
import { operate, withTiming, type FolderBucket, type HostPort } from "./folders";
import { handle, json, OP_HEADER, ORIGIN_HEADER, type AuthStore, type StoredCode, type StoredToken } from "./gateway";
import { AuthRecords } from "./auth-records";
import { APP_HEADER, CHANNEL_HEADER, folderKey, plansKey, SECRET_HEADER, viewKey } from "../src/protocol";
import { appSummaries } from "./apps-index";
import type { PageDeps } from "./page";
// Bundled as text (the `rules` in wrangler.jsonc): the CLI and the starter instructions this Worker was deployed with.
import starterCli from "../bin/appgov.mjs";
import starterAgents from "../overlay/AGENTS.start.md";

// ---------------------------------------------------------------------------
// The Cloudflare edition's Worker: the gateway in front (worker/gateway.ts),
// one Durable Object per app that owns that app's container and runs its
// operations one at a time (worker/folders.ts), and one Durable Object that
// keeps the owner's sessions and the agent tokens, hashed. The owner page's
// built client (local/web/dist) comes with the Worker as its static assets,
// which only the Worker reads (`run_worker_first`).
// ---------------------------------------------------------------------------

interface Env {
  /** The owner page's built client, local/web/dist. */
  ASSETS: Fetcher;
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
  /** The Host's own address: the owner's domain when the installer was given one, else the workers.dev address. */
  APPGOV_HOST_URL?: string;
}

const READY_WAIT_MS = 180_000;

/** app.js and app.css with a short hash of each, read once per isolate from the assets this version was deployed with. */
let pageVersions: Promise<ReadonlyMap<string, string>> | null = null;

function pageDeps(env: Env): PageDeps {
  const asset = async (name: string) => {
    const res = await env.ASSETS.fetch(new Request(`https://assets/${name}`));
    if (res.ok) return res;
    await res.body?.cancel();
    return null;
  };
  return {
    asset,
    versions: () =>
      (pageVersions ??= (async () => {
        const files = new Map<string, string>();
        for (const name of ["app.js", "app.css"]) {
          const res = await asset(name);
          if (!res) continue;
          const digest = await crypto.subtle.digest("SHA-256", await res.arrayBuffer());
          files.set(name, [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12));
        }
        return files;
      })().catch((err) => {
        pageVersions = null;
        throw err;
      })),
    spaceOrigin: env.APPGOV_SPACE_ORIGIN,
    manager: env.APPGOV_MANAGER,
  };
}
const OPERATION_LIMIT_MS = 20 * 60_000;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
      addCode: (hash, code, now, limit) => auth.addCode(hash, code, now, limit),
      takeCode: (hash, now) => auth.takeCode(hash, now),
      noteCodeToken: (id, tokenId) => auth.noteCodeToken(id, tokenId),
      codeState: (id, now) => auth.codeState(id, now),
      dropCode: (id) => auth.dropCode(id),
    };
    return handle(request, {
      starter: { cli: starterCli, agents: starterAgents },
      page: pageDeps(env),
      ownerKeyHash: env.APPGOV_OWNER_KEY_HASH,
      auth: store,
      governance: env.APPGOV_GOVERNANCE,
      ...(env.APPGOV_HOST_URL ? { hostUrl: env.APPGOV_HOST_URL } : {}),
      app: (name) => env.APPS.get(env.APPS.idFromName(name), env.APPGOV_LOCATION_HINT ? { locationHint: env.APPGOV_LOCATION_HINT as DurableObjectLocationHint } : {}),
      summaries: (steps) => appSummaries(r2(env.FOLDERS), (work) => ctx.waitUntil(work), steps),
      views: {
        view: async (app) => (await env.FOLDERS.get(viewKey(app)))?.json() ?? null,
        plans: async (app) => (await env.FOLDERS.get(plansKey(app)))?.json() ?? null,
        folderEtag: async (app) => (await env.FOLDERS.head(folderKey(app)))?.etag ?? null,
      },
      waitUntil: (work) => ctx.waitUntil(work),
      runtime: {
        read: async () => (await env.FOLDERS.get(RUNTIME_KEY))?.json() ?? null,
        list: () => planeListing(env.APPGOV_SPACE_ORIGIN, env.APPGOV_SPACE_TOKEN),
        write: async (listing) => void (await env.FOLDERS.put(RUNTIME_KEY, JSON.stringify(listing))),
      },
    });
  },
} satisfies ExportedHandler<Env>;

/** The bucket as worker/folders.ts and worker/apps-index.ts use it. */
function r2(bucket: R2Bucket): FolderBucket {
  return {
    get: async (key) => {
      const object = await bucket.get(key);
      return object ? { etag: object.etag, bytes: () => object.arrayBuffer() } : null;
    },
    put: async (key, value, condition) => {
      const put = await bucket.put(key, value, condition ? { onlyIf: condition } : {});
      return put ? { etag: put.etag } : null;
    },
    list: async (prefix) => {
      const out: { key: string; etag: string }[] = [];
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
        for (const object of page.objects) out.push({ key: object.key, etag: object.etag });
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return out;
    },
    delete: async (keys) => {
      await bucket.delete([...keys]);
    },
  };
}

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
    if (op !== "create" && op !== "read" && op !== "write" && op !== "clear" && op !== "view" && op !== "warm" && op !== "plan") return json({ error: "unknown operation", reason: "bad_op" }, 400);
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
      const bucket = r2(this.env.FOLDERS);
      const headers: Record<string, string> = {};
      for (const name of ["x-appgov-principal", APP_HEADER, CHANNEL_HEADER]) {
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

/**
 * The owner's sessions, the agent tokens and the one-time codes, by SHA-256; and failed sign-ins and wrong codes, by
 * caller, for ten minutes. The rules are worker/auth-records.ts, over this object's own storage; one call runs at a
 * time, so a code is taken once.
 */
export class AuthObject extends DurableObject<Env> {
  // RPC calls reach methods on the class, so each is spelled out.
  private readonly records = new AuthRecords(this.ctx.storage.kv);
  async addSession(hash: string, expiresAt: number) {
    return this.records.addSession(hash, expiresAt);
  }
  async hasSession(hash: string, now: number) {
    return this.records.hasSession(hash, now);
  }
  async dropSession(hash: string) {
    return this.records.dropSession(hash);
  }
  async addToken(hash: string, token: StoredToken) {
    return this.records.addToken(hash, token);
  }
  async findToken(hash: string, now: number) {
    return this.records.findToken(hash, now);
  }
  async listTokens() {
    return this.records.listTokens();
  }
  async revokeToken(id: string, now: number) {
    return this.records.revokeToken(id, now);
  }
  async loginFailures(key: string, now: number, failed: boolean) {
    return this.records.loginFailures(key, now, failed);
  }
  async addCode(hash: string, code: StoredCode, now: number, limit: number) {
    return this.records.addCode(hash, code, now, limit);
  }
  async takeCode(hash: string, now: number) {
    return this.records.takeCode(hash, now);
  }
  async noteCodeToken(id: string, tokenId: string) {
    return this.records.noteCodeToken(id, tokenId);
  }
  async codeState(id: string, now: number) {
    return this.records.codeState(id, now);
  }
  async dropCode(id: string) {
    return this.records.dropCode(id);
  }
}
