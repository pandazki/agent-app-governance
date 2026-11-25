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
/** How long each step of an operation took, in ms: `container`, `load`, `op`, `save`. */
export const TIMING_HEADER = "x-appgov-timing";

/** The owner, signed in with the owner key; or an agent token the owner created. */
export type Principal = { readonly kind: "owner" } | { readonly kind: "agent"; readonly id: string; readonly label: string };

/** The R2 key of an app's folder and of its summary. */
export const folderKey = (app: string): string => `folders/${app}.tar`;
export const summaryKey = (app: string): string => `summaries/${app}.json`;

/** App names, as the Host takes them (host/src/artifact.ts APP_NAME). */
export const APP_NAME = /^[a-z][a-z0-9-]{0,29}$/;
