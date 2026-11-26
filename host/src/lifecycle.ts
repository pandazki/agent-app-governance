import type { SpaceApp } from "./space";

// ---------------------------------------------------------------------------
// Whether an app is there: what the Host knows and what PneumaSpace says.
//
// Two facts, kept apart because they come from two places:
//   - the Host's own record: whether the owner took the app down through this
//     Host (a `take_down` entry not followed by a `bring_back` or a
//     `publish_again` one), with who did it and when;
//   - PneumaSpace's answer, the last time it was asked: serving, removed (taken
//     down there, its data kept), gone (no such app, or being purged), or
//     unknown (no answer). A claim about another system, so it carries when it
//     was made.
// Every surface (status, list, the owner page, the refusals) says what the two
// together mean, with `standingOf`, and offers the owner what `choicesFor` allows.
// Pure: the Cloudflare edition's Worker uses it on stored facts as they are.
// ---------------------------------------------------------------------------

/** What PneumaSpace said about the app. */
export type RuntimeState = "serving" | "removed" | "gone" | "unknown";

export interface RuntimeFacts {
  readonly state: RuntimeState;
  /** When PneumaSpace said it, ISO. */
  readonly checked_at: string;
  /** Why the state is `unknown`: PneumaSpace's error, as it came. */
  readonly note?: string;
  /** With `serving`: PneumaSpace has the app asleep after being idle, and the next request starts it (see `SpaceApp.asleep`). */
  readonly asleep?: true;
}

/** The owner took the app down through this Host: when, who, and through what. */
export interface DownFacts {
  readonly at: string;
  readonly by: string;
  readonly channel?: string;
  readonly credential?: string;
}

/**
 *   - `running`: PneumaSpace serves it, and nobody took it down here.
 *   - `down`: the owner took it down through this Host (PneumaSpace says what became of it).
 *   - `removed_elsewhere`: PneumaSpace holds it removed, with its data, but not by this Host's doing.
 *   - `vanished`: PneumaSpace has no such app any more, and this Host did not take it down: its stored data is gone.
 *   - `unconfirmed`: PneumaSpace did not answer; the Host knows of nothing wrong.
 */
export type Standing = "running" | "down" | "removed_elsewhere" | "vanished" | "unconfirmed";

/** What the owner may do about the app's being there, now. */
export interface OwnerChoices {
  /** Stop serving it and keep everything (PneumaSpace's `remove`). */
  readonly take_down: boolean;
  /** Serve it again with the data PneumaSpace kept. */
  readonly bring_back: boolean;
  /** Create it again on PneumaSpace from the Host's current version: the stored data is not there any more. */
  readonly publish_again: boolean;
  /** Forget it here: never while PneumaSpace serves it. */
  readonly clear: boolean;
}

/** The history entry kinds that change whether the app is down. */
export const LIFECYCLE_KINDS = ["take_down", "bring_back", "publish_again"] as const;

/** PneumaSpace's answer as a fact with its time: `app` as `SpaceRuntime.app` resolved, or the error it threw. */
export function runtimeFacts(answer: { readonly app: SpaceApp | null } | { readonly error: unknown }, at: Date = new Date()): RuntimeFacts {
  const checked_at = at.toISOString();
  if ("error" in answer) return { state: "unknown", checked_at, note: answer.error instanceof Error ? answer.error.message : String(answer.error) };
  const app = answer.app;
  if (!app) return { state: "gone", checked_at };
  // An app being purged is on its way out with its data; one PneumaSpace calls anything else (registered, draft) is there.
  if (app.status === "removed") return { state: "removed", checked_at };
  if (app.status === "purging" || app.status === "purged") return { state: "gone", checked_at };
  return { state: "serving", checked_at, ...(app.asleep ? { asleep: true as const } : {}) };
}

/** Whether the owner took the app down through this Host, from its history: the last lifecycle entry decides. */
export function downOf(history: readonly { readonly kind: string; readonly at: string; readonly agent: string; readonly channel?: string; readonly credential?: string }[]): DownFacts | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]!;
    if (!(LIFECYCLE_KINDS as readonly string[]).includes(entry.kind)) continue;
    if (entry.kind !== "take_down") return null;
    return { at: entry.at, by: entry.agent, ...(entry.channel ? { channel: entry.channel } : {}), ...(entry.credential ? { credential: entry.credential } : {}) };
  }
  return null;
}

export function standingOf(down: DownFacts | null, runtime: RuntimeFacts): Standing {
  if (down) return "down";
  if (runtime.state === "serving") return "running";
  if (runtime.state === "removed") return "removed_elsewhere";
  if (runtime.state === "gone") return "vanished";
  return "unconfirmed";
}

/**
 * What the owner may do now. Nothing is offered on a guess: while PneumaSpace does not answer, nothing; clearing never
 * while PneumaSpace serves the app; bringing back only what PneumaSpace kept, publishing again only what it does not have.
 */
export function choicesFor(standing: Standing, runtime: RuntimeFacts): OwnerChoices {
  const none = { take_down: false, bring_back: false, publish_again: false, clear: false };
  if (runtime.state === "unknown") return none;
  if (standing === "running") return { ...none, take_down: true };
  if (standing === "removed_elsewhere") return { ...none, bring_back: true, clear: true };
  if (standing === "vanished") return { ...none, publish_again: true, clear: true };
  if (standing === "down") {
    // Brought back on PneumaSpace behind this Host's back: it serves, so it can be taken down again or recorded as back.
    if (runtime.state === "serving") return { ...none, take_down: true, bring_back: true };
    if (runtime.state === "removed") return { ...none, bring_back: true, clear: true };
    return { ...none, publish_again: true, clear: true };
  }
  return none;
}

/** The newer of two facts about the same app; the first when they are as old. */
export function newerRuntime(a: RuntimeFacts, b: RuntimeFacts | null | undefined): RuntimeFacts {
  return b && Date.parse(b.checked_at) > Date.parse(a.checked_at) ? b : a;
}

/** What clearing the app would delete and leave, as status says it before the owner types the name. */
export interface ClearingFacts {
  /** This Host's runtime may delete stored data for good (`SpaceRuntime.purge`): clearing purges the app on PneumaSpace. */
  readonly purges: boolean;
  /** The data snapshots this Host's capability made for the app (refs from its history). */
  readonly snapshots: readonly string[];
  /** The capability that keeps them, by its id, or null where this Host has none. */
  readonly snapshot_capability: string | null;
  /**
   * The capability can be asked to let go of what it made for the app (`discardAll`): clearing asks it before the purge,
   * so the snapshots, and what undos set aside, are deleted. Otherwise clearing leaves them where they are.
   */
  readonly discards_snapshots: boolean;
  /** Agents work in copies held apart (they stay); otherwise the app's directory, where agents work, is deleted with the record. */
  readonly copies_apart: boolean;
  /** The same, in plain English lines, for the CLI: what is deleted, what stays, and where to finish. */
  readonly deletes: readonly string[];
  readonly keeps: readonly string[];
}

/**
 * What clearing deletes and leaves, in plain lines, from what PneumaSpace said and whether this Host's runtime may purge
 * (the capability the runtime declares, never the edition): the confirmation shows exactly these before the owner types
 * the name.
 */
export function clearingWords(
  name: string,
  runtime: RuntimeFacts,
  purges: boolean,
  snapshots: readonly string[],
  snapshotCapability: string | null,
  copiesApart = false,
  discards = false,
): ClearingFacts {
  const deletes = [
    copiesApart
      ? `this Host's record of ${name}: its versions, its history and the changes that wait for the owner, with their previews`
      : `the folder ${name} on this Host, the one agents work in, with its files, its versions, its history and the changes that wait for the owner, with their previews`,
  ];
  const keeps: string[] = [];
  if (runtime.state === "removed" && purges) deletes.push(`${name} on PneumaSpace, with all its stored data (purged): this cannot be undone`);
  if (runtime.state === "removed" && !purges) {
    keeps.push(
      `${name} on PneumaSpace, removed, with all its stored data: this Host may not purge it there. Its name, its app slot and its storage stay taken until the PneumaSpace owner purges it in PneumaSpace's console`,
    );
  }
  if (runtime.state === "gone") keeps.push(`nothing on PneumaSpace: it has no app named ${name} any more`);
  const holder = snapshotCapability ?? "the snapshot capability";
  if (snapshots.length && discards) {
    deletes.push(`the data snapshots this Host made of ${name} (${snapshots.join(", ")}), with the data its undos set aside, where ${holder} keeps them: ${holder} lets go of them first`);
  } else if (snapshots.length) {
    keeps.push(`the data snapshots this Host made of ${name} (${snapshots.join(", ")}), where ${holder} keeps them: clearing does not delete them`);
  }
  if (copiesApart) keeps.push("the working copies agents hold: they stay where they are, and can no longer submit");
  return { purges, snapshots: [...snapshots], snapshot_capability: snapshotCapability, discards_snapshots: discards, copies_apart: copiesApart, deletes, keeps };
}

/**
 * Every app PneumaSpace holds for this Host's tenant, from one listing at one moment: name to the platform's status.
 * An app the Host knows that is not in it is gone. The Cloudflare edition's Worker keeps the last one (worker/runtime-check.ts).
 */
export interface RuntimeListing {
  readonly checked_at: string;
  readonly apps: Readonly<Record<string, string>>;
}

/** What the listing says about one app. */
export function factsFromListing(listing: RuntimeListing, name: string): RuntimeFacts {
  const status = Object.hasOwn(listing.apps, name) ? listing.apps[name] : undefined;
  return runtimeFacts({ app: status === undefined ? null : { name, status: status as SpaceApp["status"], expiresAt: null, manager: null } }, new Date(listing.checked_at));
}

/** The presence fields status and the summaries carry, as far as this module reads and restates them. */
interface Presence {
  readonly app_id?: unknown;
  readonly runtime?: unknown;
  readonly taken_down?: unknown;
  readonly standing?: unknown;
  readonly choices?: unknown;
  readonly clearing?: unknown;
}

const isFacts = (value: unknown): value is RuntimeFacts =>
  typeof value === "object" && value !== null && typeof (value as RuntimeFacts).state === "string" && typeof (value as RuntimeFacts).checked_at === "string";

/**
 * Status (`status`: true) or a summary as stored, restated from a newer listing when there is one: the newer fact about
 * PneumaSpace wins, and the standing, the owner's choices and what clearing would do follow from it. Unchanged when the
 * stored facts are as new. One stored by a Host from before these fields carries none: the listing alone says what
 * PneumaSpace holds (no app could be taken down through a Host from before them), and a status gets the choices.
 */
export function restated<T extends Presence>(fields: T, name: string, listing: RuntimeListing | null | undefined, status = false): T {
  if (!listing) return fields;
  const stored = isFacts(fields.runtime) ? fields.runtime : null;
  const listed = factsFromListing(listing, name);
  const runtime = stored ? newerRuntime(stored, listed) : listed;
  if (runtime === stored) return fields;
  const down = (typeof fields.taken_down === "object" && fields.taken_down !== null ? fields.taken_down : null) as DownFacts | null;
  const standing = standingOf(down, runtime);
  const out: Record<string, unknown> = { ...(fields as Record<string, unknown>), runtime, standing };
  if (fields.choices !== undefined || status) out.choices = choicesFor(standing, runtime);
  const clearing = fields.clearing as ClearingFacts | undefined;
  if (clearing && Array.isArray(clearing.snapshots)) {
    out.clearing = clearingWords(
      name,
      runtime,
      Boolean(clearing.purges),
      clearing.snapshots,
      typeof clearing.snapshot_capability === "string" ? clearing.snapshot_capability : null,
      clearing.copies_apart === true,
      clearing.discards_snapshots === true,
    );
  }
  return out as T;
}
