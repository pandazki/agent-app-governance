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

/** The R2 key of an app's folder, of its summary, and of its stored view. */
export const folderKey = (app: string): string => `folders/${app}.tar`;
export const summaryKey = (app: string): string => `summaries/${app}.json`;
export const viewKey = (app: string): string => `views/${app}.json`;

/**
 * The shape of a stored view (StoredView). Raise it whenever what a view holds changes in shape or in meaning: a
 * Worker serves only views of its own shape, and asks the container for a new one when it finds another.
 */
export const VIEW_SCHEMA = 1;

/**
 * What every read of one app needs, as the Host in the container computes it: the answers of `GET /apps/<app>`
 * (status, with the risks the standing rule lets through and each waiting change's files signature), of
 * `GET /apps/<app>/history`, and of `GET /apps/<app>/undo-plan/<version>` for each version the current one was built
 * on. The app's Durable Object stores it in R2 beside the folder after every operation that saved the folder, so the
 * Worker answers reads (the owner page's views, the CLI's status and history) without a container.
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
  readonly history: readonly Record<string, unknown>[];
  /** By version: the plan for going back to it, or null where the Host would not plan it. */
  readonly plans: Readonly<Record<string, Record<string, unknown> | null>>;
}

/** App names, as the Host takes them (host/src/artifact.ts APP_NAME). */
export const APP_NAME = /^[a-z][a-z0-9-]{0,29}$/;
