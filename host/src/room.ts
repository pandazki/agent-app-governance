import type { AwakeSlots, PublishResult, SpaceRuntime } from "./space";
import { timed } from "./steps";

// ---------------------------------------------------------------------------
// Room on PneumaSpace for an app to start.
//
// A workspace has a few awake slots (PneumaSpace's `awake` quota, 2 by
// default), and starting a Node app, a preview included, takes one. When all
// are held, PneumaSpace refuses the release. The Host then makes room only
// with what is its own to put away, which the caller names: for a preview,
// the app's own live instance, which the release replaces anyway. It never
// puts another app to sleep, managed by it or not. Then it waits a bounded
// time, asking who holds the slots, and publishes again once one is free.
// A refusal that stands says who holds them and what was tried.
// ---------------------------------------------------------------------------

export interface Room {
  /** How long to wait in all for a slot to come free, in ms. */
  readonly waitMs: number;
  /** How often to ask PneumaSpace who holds the slots meanwhile, in ms. */
  readonly pollMs: number;
}

/** An awake app goes to sleep after 5 minutes without requests on PneumaSpace's default policy; the wait is shorter. */
export const DEFAULT_ROOM: Room = { waitMs: 60_000, pollMs: 5_000 };

/** Publishes in all, the first included: before pandazki/pneuma-space#71, PneumaSpace counted each refused one as a failed start of the app. */
const ATTEMPTS = 3;

/** The line a runtime puts into the output of a publish refused because every awake slot was held. */
const NO_ROOM = /^quota \{"resource":"awake"/m;

export function refusedForRoom(result: PublishResult): boolean {
  return result.code !== 0 && NO_ROOM.test(result.output);
}

/** What a refusal that stands says about the slots and when to try again, after `awake slots: ` in its output (see `publishMakingRoom`). */
export function heldSlots(output: string): string | undefined {
  return /^awake slots: (.*)$/m.exec(output)?.[1];
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function slotsText(held: AwakeSlots | null, manager: string): string {
  if (!held) return "every awake slot of the workspace is held, and PneumaSpace did not say by which apps";
  const names = held.apps.map((app) => `${app.name} (${app.manager === manager ? "managed by this Host" : "not managed by this Host"})`);
  const by = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "apps PneumaSpace did not name");
  return `all ${held.limit} awake slots of the workspace are held, by ${by}`;
}

/**
 * `publish`, and when PneumaSpace refuses it because every awake slot is held: put those of `own` that hold one to
 * sleep, wait up to `room.waitMs` for a slot, and publish again once one is free. `own` names apps this Host may put to
 * sleep for this publish; nothing else is touched. When no slot comes free, the result is the last refusal, with an
 * `awake slots: ` line that says who holds them and what was tried.
 */
export async function publishMakingRoom(space: SpaceRuntime, room: Room, manager: string, own: readonly string[], publish: () => Promise<PublishResult>): Promise<PublishResult> {
  let result = await publish();
  if (!refusedForRoom(result) || !space.awake) return result;
  const began = Date.now();
  const ask = () => space.awake!().catch(() => null);
  let held = await ask();
  const slept: string[] = [];
  for (const name of own) {
    if (held && !held.apps.some((app) => app.name === name)) continue;
    try {
      await timed(`put ${name} to sleep to make room`, () => space.stop(name));
      slept.push(name);
    } catch {
      // Not put to sleep: the wait below may still find a slot.
    }
  }
  let attempts = 1;
  await timed("wait for an awake slot", async () => {
    for (;;) {
      held = await ask();
      // Unknown counts as free: publishing is how to find out.
      if (!held || held.apps.length < held.limit) {
        result = await publish();
        attempts++;
        if (!refusedForRoom(result) || attempts >= ATTEMPTS) return;
        continue;
      }
      if (Date.now() + room.pollMs > began + room.waitMs) return;
      await wait(room.pollMs);
    }
  });
  if (!refusedForRoom(result)) return result;
  const tried = `${slept.length ? `this Host put ${slept.join(" and ")} to sleep to make room and ` : "this Host "}waited ${Math.round((Date.now() - began) / 1000)} s for one to come free`;
  const later = "An awake app goes to sleep after some minutes without requests (5 on PneumaSpace's default policy), so trying again later will work";
  return { ...result, output: `${result.output}\nawake slots: ${slotsText(held, manager)}; ${tried}. ${later}` };
}
