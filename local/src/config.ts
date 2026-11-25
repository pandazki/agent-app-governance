import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openBunSql, POSTGRES_TEMPLATE, postgresTemplateSnapshot, serverOf } from "./data-snapshot-postgres";
import { AppHost, type HostDataSnapshot } from "../../host/src/host";
import { GOVERNANCE_MODES, loadRiskPolicy, type GovernanceMode } from "../../host/src/policy";
import { DEFAULT_PREVIEW_TTL_SECONDS } from "../../host/src/preview";
import { cdpScreenshotter, runtimeAddressMapper, ScreenshotKeeper, type PictureSource } from "./screenshots";
import { DEFAULT_MANAGER, SPACE_NAME, spaceFromEnv, type SpaceRuntime } from "../../host/src/space";

const here = dirname(fileURLToPath(import.meta.url));
export const EXAMPLE_ROOT = resolve(here, "..");

type Env = Record<string, string | undefined>;

/** What an implementation may need besides the variables: the runtime the Host publishes to, and its log. */
export interface DataSnapshotContext {
  readonly space?: SpaceRuntime;
  readonly log?: (line: string) => void;
}

/**
 * The data snapshot implementations this Host can be started with, by the name `APPGOV_DATA_SNAPSHOT`
 * gives. Each is a practice this Host shows, not something the framework or PneumaSpace promises.
 * Without one, an undo past a one-way change puts back only code, and only with the owner's confirmation.
 */
export const DATA_SNAPSHOT_IMPLEMENTATIONS: Readonly<Record<string, (env: Env, context: DataSnapshotContext) => HostDataSnapshot>> = {
  /** Apps whose database PneumaSpace put on PostgreSQL: a snapshot is `CREATE DATABASE ... TEMPLATE` on the same server. */
  [POSTGRES_TEMPLATE]: (env, context) => {
    const url = env.APPGOV_DATA_SNAPSHOT_URL?.trim();
    if (!url) {
      throw new Error(
        `APPGOV_DATA_SNAPSHOT is ${POSTGRES_TEMPLATE}, which needs APPGOV_DATA_SNAPSHOT_URL: a superuser connection to the PostgreSQL server ` +
          "PneumaSpace puts app databases on, e.g. postgresql://postgres:pneuma-local@postgres:5432/postgres. Set it, or unset APPGOV_DATA_SNAPSHOT to run without one.",
      );
    }
    let protocol: string;
    try {
      protocol = new URL(url).protocol;
    } catch {
      throw new Error("APPGOV_DATA_SNAPSHOT_URL is not a URL; it must look like postgresql://postgres:<password>@postgres:5432/postgres");
    }
    if (protocol !== "postgresql:" && protocol !== "postgres:") {
      throw new Error(`APPGOV_DATA_SNAPSHOT_URL must be a postgresql:// URL, not ${protocol}//`);
    }
    return postgresTemplateSnapshot({
      space: context.space ?? spaceFromEnv(env),
      connect: () => openBunSql(url),
      server: serverOf(url),
      log: context.log,
    });
  },
};

/** The data snapshot capability `APPGOV_DATA_SNAPSHOT` names, or none when it is unset or empty. An unknown name, or a missing setting it needs, stops the Host at start. */
export function dataSnapshotFromEnv(env: Env = process.env, context: DataSnapshotContext = {}): HostDataSnapshot | undefined {
  const name = env.APPGOV_DATA_SNAPSHOT?.trim();
  if (!name) return undefined;
  const make = DATA_SNAPSHOT_IMPLEMENTATIONS[name];
  if (!make) {
    throw new Error(
      `APPGOV_DATA_SNAPSHOT names "${name}", but this Host has no data snapshot implementation by that name ` +
        `(known: ${Object.keys(DATA_SNAPSHOT_IMPLEMENTATIONS).join(", ")}). Unset it to run without one.`,
    );
  }
  return make(env, context);
}

/**
 * The served Host's own address as the person's machine reaches it. `APPGOV_HOST_URL` when set (compose
 * sets it from the published port, which the Host inside the container cannot see). Otherwise derived
 * from where `bun run serve` listens: the loopback address for a wildcard bind, else the bind address.
 */
export function hostUrlFromEnv(env: Env, bind: string, port: number): string {
  const configured = env.APPGOV_HOST_URL?.trim();
  if (configured) {
    let protocol: string;
    try {
      protocol = new URL(configured).protocol;
    } catch {
      throw new Error(`APPGOV_HOST_URL is not a URL: "${configured}"; it must look like http://127.0.0.1:8090`);
    }
    if (protocol !== "http:" && protocol !== "https:") throw new Error(`APPGOV_HOST_URL must be an http:// or https:// address, not "${configured}"`);
    return configured.replace(/\/+$/, "");
  }
  // The address is recorded in every app before anything connects, so it needs the port in advance: 0 (a port
  // the system picks) would be recorded as is, and every CLI copy would then try port 0.
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `APPGOV_HOST_PORT must be a port from 1 to 65535, not "${env.APPGOV_HOST_PORT ?? port}": this Host records its address in every app, so it needs a fixed port. ` +
        "To listen on another kind of port, also set APPGOV_HOST_URL to the address the Host is reached at.",
    );
  }
  const host = bind === "0.0.0.0" || bind === "" ? "127.0.0.1" : bind === "::" ? "[::1]" : bind.includes(":") ? `[${bind}]` : bind;
  return `http://${host}:${port}`;
}

/**
 * This Host as the manager of what it publishes on PneumaSpace: `APPGOV_MANAGER` (default appgov), with
 * the Host's own page as where a person acts through it, when the Host knows its address.
 */
export function managerFromEnv(env: Env, hostUrl?: string): { name: string; url?: string } {
  const name = env.APPGOV_MANAGER?.trim() || DEFAULT_MANAGER;
  if (!SPACE_NAME.test(name)) throw new Error(`APPGOV_MANAGER must be a name PneumaSpace accepts (${SPACE_NAME.source}), not "${name}"`);
  return { name, ...(hostUrl ? { url: `${hostUrl.replace(/\/+$/, "")}/` } : {}) };
}

/** Seconds a preview stands before it ends itself: `APPGOV_PREVIEW_TTL`, default 3600. */
export function previewTtlFromEnv(env: Env): number {
  const raw = env.APPGOV_PREVIEW_TTL?.trim();
  if (!raw) return DEFAULT_PREVIEW_TTL_SECONDS;
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`APPGOV_PREVIEW_TTL must be a whole number of seconds above 0, not "${raw}"`);
  return Number(raw);
}

/**
 * Where the served Host keeps its own state (pictures of apps, the owner token): `APPGOV_HOST_STATE`, else a directory in the
 * system's temporary directory. Never inside the apps directory, which the agent can write.
 */
export function hostStateDir(env: Env = process.env): string {
  return resolve(env.APPGOV_HOST_STATE?.trim() || join(tmpdir(), "agent-app-governance-host-state"));
}

/**
 * The owner page's pictures. `APPGOV_SCREENSHOT_CDP` names the headless browser's DevTools endpoint (compose:
 * the `screenshot` service); unset, there are no pictures and the page shows placeholders. The browser reaches
 * apps at `APPGOV_SCREENSHOT_APPS_URL`, else at `APPGOV_SPACE_INGRESS`, the address this Host reaches them at.
 */
export function picturesFromEnv(env: Env, source: PictureSource, log: (line: string) => void): ScreenshotKeeper {
  const endpoint = env.APPGOV_SCREENSHOT_CDP?.trim();
  const ingress = env.APPGOV_SCREENSHOT_APPS_URL?.trim() || env.APPGOV_SPACE_INGRESS || "http://127.0.0.1:8080";
  const hours = Number(env.APPGOV_SCREENSHOT_REFRESH_HOURS ?? 24);
  return new ScreenshotKeeper({
    source,
    ...(endpoint ? { shooter: cdpScreenshotter({ endpoint }) } : {}),
    dir: join(hostStateDir(env), "pictures"),
    insideUrl: runtimeAddressMapper(env.APPGOV_SPACE_PUBLIC ?? "http://127.0.0.1:8080", ingress),
    refreshAfterMs: Number.isFinite(hours) && hours >= 0 ? hours * 3_600_000 : 86_400_000,
    log,
  });
}

/** Both entry points (the served Host and the host-driven CLI) build the same Host from the same variables. Only the served Host passes its own address. */
export function hostFromEnv(env: Env = process.env, log: (line: string) => void = console.error, extra: { readonly hostUrl?: string } = {}): AppHost {
  const governance = (env.APPGOV_GOVERNANCE ?? "personal") as GovernanceMode;
  if (!GOVERNANCE_MODES.includes(governance)) throw new Error(`APPGOV_GOVERNANCE must be ${GOVERNANCE_MODES.join(", ")}`);
  const space = spaceFromEnv(env);
  return new AppHost({
    appsDir: resolve(env.APPGOV_APPS_DIR ?? join(EXAMPLE_ROOT, "apps")),
    space,
    overlayDir: join(EXAMPLE_ROOT, "overlay"),
    cliSource: join(EXAMPLE_ROOT, "bin", "appgov.mjs"),
    owner: env.APPGOV_OWNER ?? "user:me",
    governance,
    // The rules are a preset, not code. An empty variable falls back to the example preset like an unset one.
    policy: loadRiskPolicy(resolve(env.APPGOV_POLICY_FILE || join(EXAMPLE_ROOT, "policy", "personal.json"))),
    preview: env.APPGOV_PREVIEW !== "off",
    previewTtlSeconds: previewTtlFromEnv(env),
    manager: managerFromEnv(env, extra.hostUrl),
    dataSnapshot: dataSnapshotFromEnv(env, { space, log }),
    hostUrl: extra.hostUrl,
    // For links from the owner page. In the container APPGOV_SPACE_ADMIN is the gateway's inside address, so compose sets this.
    consoleUrl: env.APPGOV_SPACE_CONSOLE?.trim() || env.APPGOV_SPACE_ADMIN || "http://127.0.0.1:8081",
    log,
  });
}
