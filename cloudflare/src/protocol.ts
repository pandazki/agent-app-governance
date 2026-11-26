// ---------------------------------------------------------------------------
// What the Worker, the app's Durable Object and the Host in the container say
// to each other. Shared by both sides; nothing here is a credential.
// ---------------------------------------------------------------------------

/** The secret the Worker and the container share. The Host refuses every request without it. */
export const SECRET_HEADER = "x-appgov-container-secret";
/** Who the Worker authenticated: JSON of a `Principal`. The Host trusts it only next to the secret. */
export const PRINCIPAL_HEADER = "x-appgov-principal";
/** The R2 etag of the folder the Durable Object expects the container to hold, or `none` for an app being created. */
export const FOLDER_HEADER = "x-appgov-folder-etag";
/** The app an operation is about, set by the Worker. */
export const APP_HEADER = "x-appgov-app";
/** Set by the Worker on the owner page's own writes: the Host writes it into the entry as `channel`. */
export const CHANNEL_HEADER = "x-appgov-channel";
/** The one channel there is: a decision or an undo made on the owner page. */
export const PAGE_CHANNEL = "owner-page";
/**
 * The level of the centre's API, in the `appgov-api` header of every answer the Worker gives. The CLI (bin/appgov.mjs,
 * HOST_API_LEVEL there) refuses to work with a centre at another level, so it never misreads an answer. Raise both
 * together when the CLI starts to rely on something new, or stops understanding something old.
 * 1: GET /starter, the `appgov-api` header, `credential` and `author` in entries, `tree_signature` on waiting changes.
 */
export const API_LEVEL = 1;
export const API_HEADER = "appgov-api";
/** How long each step of an operation took, in ms: `container`, `load`, `op`, `save`. */
export const TIMING_HEADER = "x-appgov-timing";

/** The subject that holds the owner role in every app this edition's Host creates (the container's default). */
export const OWNER_SUBJECT = "user:owner";

/** The owner, signed in with the owner key; or an agent token the owner created. */
export type Principal = { readonly kind: "owner" } | { readonly kind: "agent"; readonly id: string; readonly label: string };

/** The R2 key of an app's folder, of its summary, of its stored view, and of the plans worked out when the owner asked. */
export const folderKey = (app: string): string => `folders/${app}.tar`;
export const summaryKey = (app: string): string => `summaries/${app}.json`;
export const viewKey = (app: string): string => `views/${app}.json`;
export const plansKey = (app: string): string => `plans/${app}.json`;
/** One object with every app's summary (StoredIndex), which saves the list of apps reading each summary. */
export const INDEX_KEY = "apps.json";

/**
 * The shape of a stored view (StoredView) and of an app's asked-for plans (StoredPlans). Raise it whenever what they
 * hold changes in shape or in meaning: a Worker serves only those of its own shape, and asks the container for new
 * ones when it finds another.
 */
export const VIEW_SCHEMA = 2;

/**
 * How many plans for going back a stored view carries: for the versions nearest the current one on the line it was
 * built on. The owner page shows an app's newest 8 history rows before "Show earlier" (local/web/src/app-view.tsx),
 * and each row offers at most one version to go back to, all of them among those 8 nearest; a plan for an older
 * version is worked out when the owner opens it (StoredPlans).
 */
export const PLANS_KEPT = 8;

/**
 * How many history entries, the newest, a stored view carries. They are what the app's page shows, its first 8 rows
 * and the rest "Show earlier" opens without asking again; an app with more has the whole history read from its folder
 * when someone asks for it (the page's whole history, the CLI's `history`).
 */
export const HISTORY_KEPT = 50;

/**
 * What every read of one app needs without a further click, as the Host in the container computes it: the answer of
 * `GET /apps/<app>` (status, with the risks the standing rule lets through and each waiting change's files
 * signature), the newest HISTORY_KEPT entries of `GET /apps/<app>/history` with how many there are in all, and the
 * plan of `GET /apps/<app>/undo-plan/<version>` for the PLANS_KEPT versions nearest the current one on the line it was
 * built on. Its size does not grow with the app's age. The app's Durable Object stores it in R2 beside the folder
 * after every operation that saved the folder, so the Worker answers reads (the owner page's views, the CLI's status,
 * and its history while the view holds all of it) without a container.
 *
 * `folder_etag` is the R2 etag of the folder it was computed from. A reader serves the view only while the folder in
 * R2 still has that etag and `schema` is VIEW_SCHEMA; otherwise the container computes it again once, and the Durable
 * Object stores the new one (worker/views.ts). What the platform said (each preview's state, who manages the app on
 * PneumaSpace) is as it was when the view was computed, except that a preview past its end is taken as gone; a
 * decision checks the platform for real.
 */
export interface StoredView {
  readonly schema: number;
  readonly app: string;
  readonly folder_etag: string;
  readonly computed_at: string;
  readonly status: Record<string, unknown>;
  /** The newest HISTORY_KEPT entries, oldest first, as the whole history has them. */
  readonly history: readonly Record<string, unknown>[];
  /** How many entries the whole history has: more than `history` holds when the app has more than HISTORY_KEPT. */
  readonly history_total: number;
  /**
   * By version: the plan for going back to it, or null where the Host would not plan it. Each plan carries the
   * history entries the page reads beside it that are older than `history` (`entries`: of the ones that made each
   * version from the current one down to it, and the snapshot of data it would bring back), so with `history` it reads
   * the same as with the whole history. A plan in StoredPlans does the same against the view of its folder.
   */
  readonly plans: Readonly<Record<string, Record<string, unknown> | null>>;
}

/**
 * Plans for going back that the owner opened and the stored view does not carry, worked out by the container when
 * asked and kept for the folder they were worked out from: a reader takes one only while `folder_etag` is the etag of
 * the folder in R2 now, as for the view. At most PLANS_KEPT, the ones asked for last; any write makes them all stale.
 */
export interface StoredPlans {
  readonly schema: number;
  readonly app: string;
  readonly folder_etag: string;
  /** Oldest asked first. */
  readonly plans: readonly { readonly version: string; readonly plan: Record<string, unknown> | null }[];
}

/**
 * Every app's summary in one object, each with the etag of the summary object it copies (worker/apps-index.ts). The
 * list of apps lists `summaries/` and reads this at the same moment, and takes from it only the summaries whose etag
 * is the one listed: it saves reading each summary, and is never trusted beyond what the listing confirms.
 */
export interface StoredIndex {
  readonly schema: number;
  readonly apps: Readonly<Record<string, { readonly etag: string; readonly summary: Record<string, unknown> }>>;
}

/** App names, as the Host takes them (host/src/artifact.ts APP_NAME). */
export const APP_NAME = /^[a-z][a-z0-9-]{0,29}$/;
