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
  return { state: "serving", checked_at };
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
