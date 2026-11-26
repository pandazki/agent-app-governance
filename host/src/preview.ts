import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshot, sourceSignature } from "./artifact";
import { makePreviewRequests, refusalText, type PreviewRequest, type PreviewRequestFacts } from "./preview-requests";
import { DEFAULT_ROOM, heldSlots, publishMakingRoom, refusedForRoom, type Room } from "./room";
import type { SpaceApp, SpaceManager, SpaceRuntime } from "./space";
import { timed } from "./steps";

// ---------------------------------------------------------------------------
// Previews on PneumaSpace.
//
// A preview is an ephemeral app (PneumaSpace ADR 0038) under its own name,
// marked as managed by this Host. It ends itself with its data after the
// preview ttl, and one call discards it. Whether it still stands and when it
// ends are PneumaSpace's facts: they are asked when someone needs them. The
// Host keeps one note, the id of the app its publish returned, so a discard
// ends that app and never a later one that took the name once it was free.
// ---------------------------------------------------------------------------

/** PneumaSpace's default `ephemeral_max_ttl_seconds`: the longest a preview may stand unless its global policy allows more. */
export const DEFAULT_PREVIEW_TTL_SECONDS = 3600;

/** A preview as PneumaSpace answers for it at the moment it is asked. */
export type PreviewState =
  | { readonly state: "standing"; readonly app: string; readonly address: string; readonly expires_at: string | null }
  /**
   * `gone`: nothing under its name is this change's preview serving now. It ended or is ending, was discarded or
   * removed, or another app holds the name. `unknown`: PneumaSpace did not answer.
   */
  | { readonly state: "gone" | "unknown"; readonly app: string; readonly note: string };

export type StandingPreview = Extract<PreviewState, { state: "standing" }>;

/**
 * `id`: the app id PneumaSpace returned for the preview, which a discard of it carries. `refused`: PneumaSpace refused
 * to publish it for a reason that is not the change's (the tenant's ephemeral quota, or a ttl above its maximum), in words.
 */
export type Booted =
  | { readonly ok: true; readonly output: string; readonly preview: StandingPreview; readonly id?: string; readonly requests?: PreviewRequestFacts }
  /** `requests`: the app's own requests were made and one did not answer as expected; `refusal` says what was sent and what came back. */
  | { readonly ok: false; readonly output: string; readonly refused?: string; readonly requests?: { readonly facts: PreviewRequestFacts; readonly refusal: string } };

/**
 * Why PneumaSpace refused to publish a preview, in words, when the reason is not the change: the tenant's ephemeral
 * quota (appctl prints the refusal's `quota` field), every awake slot held (host/src/room.ts), or a ttl above
 * `ephemeral_max_ttl_seconds`. Undefined otherwise.
 */
function refusal(output: string, ttlSeconds: number): string | undefined {
  const fine = "Nothing was found wrong with the change itself, and nothing was released.";
  if (refusedForRoom({ code: 1, output })) {
    return `${fine} PneumaSpace refused to start the preview: ${heldSlots(output) ?? "every awake slot of the workspace is held; trying again later will work"}`;
  }
  let quota: { resource?: unknown; used?: unknown; limit?: unknown } | undefined;
  try {
    quota = JSON.parse(/^quota (\{.*\})$/m.exec(output)?.[1] ?? "null") ?? undefined;
  } catch {}
  if (quota?.resource === "ephemeral" && typeof quota.used === "number" && typeof quota.limit === "number" && quota.used < quota.limit) {
    // PneumaSpace refuses a new app with the same code when the tenant's storage is full, and ephemeral apps are left.
    return (
      `PneumaSpace refused to publish the preview: the workspace's storage is full, not its ephemeral apps (${quota.used} of ${quota.limit} in use). ` +
      `Each app and each preview holds a share of it. ${fine} A preview discarded in the last few minutes still holds its share until PneumaSpace has purged it, so trying again in a few minutes may work; ` +
      "otherwise the PneumaSpace owner frees storage by purging an app"
    );
  }
  if (quota?.resource === "ephemeral") {
    return (
      `PneumaSpace refused to publish the preview: the tenant's ephemeral apps are all in use (${String(quota.used)} of ${String(quota.limit)}), ` +
      `and each change waiting for the owner holds one until it is decided or its preview ends. ${fine} Decide a waiting change, or wait for a preview to end, then try again`
    );
  }
  const max = /ephemeral ttl_seconds must be a whole number from 1 to (\d+)/.exec(output)?.[1];
  if (max) {
    return (
      `PneumaSpace refused to publish the preview: its ttl, ${ttlSeconds} s (APPGOV_PREVIEW_TTL), is above the ${max} s PneumaSpace allows (ephemeral_max_ttl_seconds). ` +
      `${fine} Lower APPGOV_PREVIEW_TTL to ${max} or less and restart the Host, then try again`
    );
  }
  return undefined;
}

/** The name a change's preview goes by on PneumaSpace: at most 37 characters for an app name of at most 30. */
export function previewName(app: string, changeId: string): string {
  return `${app}-pv${changeId.slice(-4)}`;
}

export class Previews {
  constructor(
    private readonly opts: {
      readonly space: SpaceRuntime;
      readonly manager: SpaceManager;
      readonly ttlSeconds: number;
      readonly log: (line: string) => void;
      /** How long a preview waits for an awake slot when every one is held (host/src/room.ts). Default one minute. */
      readonly room?: Room;
    },
  ) {}

  /**
   * Publish `root` as the ephemeral app `app` and see that it answers; one that does not is discarded
   * again, as is one PneumaSpace created and then refused to release. A PneumaSpace from before ephemeral
   * apps ignores the marker and keeps a durable app, which would never end: that one is taken down again
   * and the preview fails, saying why. `own` names the apps this preview may put to sleep when every
   * awake slot is held: the app's own live instance, which the release replaces anyway.
   */
  async boot(app: string, root: string, check?: { readonly file: string; readonly requests: readonly PreviewRequest[] }, own: readonly string[] = []): Promise<Booted> {
    const { space, manager } = this.opts;
    const published = await timed("publish the preview", () =>
      publishMakingRoom(space, this.opts.room ?? DEFAULT_ROOM, manager.name, app, own, () => space.publish(app, root, { ephemeral: { ttlSeconds: this.opts.ttlSeconds }, manager })),
    );
    let output = `[preview ${app}] ${published.output}`;
    if (published.code !== 0) {
      // Created and then refused: it holds an ephemeral slot and storage until it ends, so it goes now.
      if (published.app) await this.drop(app, published.app);
      const refused = refusal(published.output, this.opts.ttlSeconds);
      return refused ? { ok: false, output, refused } : { ok: false, output };
    }
    const keepAwake = Boolean(check?.requests.length);
    const probe = await timed("wait until the preview answers", () => space.probe(app, { keepAwake }));
    output += `\n[preview ${app}] GET / -> ${probe.status} ${probe.detail}`;
    if (!probe.ok) {
      await this.drop(app, published.app);
      return { ok: false, output };
    }
    // PneumaSpace's answer about the preview, asked while the app's own requests are made: nothing they do changes it.
    const reading = timed("read the preview's state (at the same time)", () => this.read(app));
    let facts: PreviewRequestFacts | undefined;
    if (check && keepAwake) {
      const send = space.request?.bind(space);
      const made = send
        ? await timed("make the app's own requests", () => makePreviewRequests(app, check.file, check.requests, send))
        : { facts: { file: check.file, declared: check.requests.length, made: 0, answered: 0, note: `This platform runtime cannot make the requests in ${check.file}.` }, failures: ["no request was made"] };
      space.rest?.(app);
      facts = made.facts;
      output += `\n[preview ${app}] ${made.facts.note}`;
      if (made.failures.length) {
        await reading;
        await this.drop(app, published.app);
        return { ok: false, output, requests: { facts: made.facts, refusal: refusalText(made.facts, made.failures, app) } };
      }
    }
    const { state: preview, listed } = await reading;
    if (listed && listed.expiresAt === null) {
      await space.takeDown(app, manager.name);
      return { ok: false, output: `${output}\n[preview ${app}] PneumaSpace kept the preview as a durable app, so it does not know ephemeral apps (its ADR 0038) and the preview would never end; it was taken down again. Use the PneumaSpace this Host is pinned to, or APPGOV_PREVIEW=off.` };
    }
    if (preview.state === "gone") {
      await this.drop(app, published.app);
      return { ok: false, output: `${output}\n[preview ${app}] ${preview.note}` };
    }
    // PneumaSpace did not say when it ends: it answered a moment ago, so it stands.
    const standing: StandingPreview = preview.state === "standing" ? preview : { state: "standing", app, address: space.address(app), expires_at: null };
    return { ok: true, output, preview: standing, ...(published.app ? { id: published.app } : {}), ...(facts ? { requests: facts } : {}) };
  }

  /**
   * The preview stands, or a new one goes up under the same name, from a private copy of `draft` that has
   * to match `signature`, the draft as it was checked. Whatever is still listed under the name is discarded
   * first, and only when it is the app this Host published as `id`: a publish onto a preview that ended but
   * was not swept yet would land in it and keep its end, and an app someone else published is not this
   * Host's to end. Never throws.
   */
  async ensure(
    app: string,
    draft: string,
    signature: string,
    id: string | undefined,
    own: readonly string[] = [],
  ): Promise<{ ok: true; preview: StandingPreview; republished: boolean; id?: string } | { ok: false; reason: string; detail: string }> {
    const { state: now, listed } = await this.read(app);
    if (now.state === "standing") return { ok: true, preview: now, republished: false };
    // It may still stand: nothing is discarded or published on a guess.
    if (now.state === "unknown") return { ok: false, reason: "preview_unknown", detail: `${now.note}. Nothing was discarded or published, and the change still waits; ask again in a minute` };
    const copy = mkdtempSync(join(tmpdir(), "appgov-preview-"));
    try {
      snapshot(draft, copy);
      if (sourceSignature(copy) !== signature) return { ok: false, reason: "draft_changed_after_check", detail: "the change's draft is not what was checked, so a preview would not show it; nothing was published. Deny the change and submit it again" };
      if (listed && !(id && (await this.opts.space.discard(app, this.opts.manager.name, id)))) {
        return { ok: false, reason: "preview_failed", detail: `${now.state === "gone" ? now.note : `PneumaSpace still lists ${app}`}. This Host discards only the preview it published, by the id PneumaSpace returned for it, so a new preview cannot take the name while that app holds it` };
      }
      const booted = await this.boot(app, copy, undefined, own);
      if (booted.ok) return { ok: true, preview: booted.preview, republished: true, ...(booted.id ? { id: booted.id } : {}) };
      if (booted.refused) return { ok: false, reason: "preview_refused", detail: `${booted.refused}. The change still waits.\n${booted.output.slice(-600)}` };
      return { ok: false, reason: "preview_failed", detail: `the preview did not come up, so nobody can look at it; the change still waits.\n${booted.output.slice(-600)}` };
    } catch (err) {
      return { ok: false, reason: "preview_failed", detail: `the change's draft could not be copied (${err instanceof Error ? err.message : String(err)}); nothing was published` };
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }

  /** Whether the preview stands and when it ends, as PneumaSpace says now. Never throws. */
  async state(app: string): Promise<PreviewState> {
    return (await this.read(app)).state;
  }

  /** The preview's state, and what PneumaSpace lists under its name (undefined when it did not answer). */
  private async read(app: string): Promise<{ state: PreviewState; listed?: SpaceApp | null }> {
    let listed: SpaceApp | null;
    try {
      listed = await this.opts.space.app(app);
    } catch (err) {
      return { state: { state: "unknown", app, note: `PneumaSpace did not say whether the preview ${app} still stands (${err instanceof Error ? err.message : String(err)})` } };
    }
    return { state: this.judge(app, listed), listed };
  }

  /**
   * An app listed under the preview's name is the change's preview only while this Host manages it, it is
   * `registered`, and its end is still ahead. PneumaSpace lists an app until it is purged: a removed one, one
   * whose end failed (`purging`), and one whose end passed before the sweep ran all serve nothing.
   */
  private judge(app: string, listed: SpaceApp | null): PreviewState {
    const ours = this.opts.manager.name;
    const gone = (note: string): PreviewState => ({ state: "gone", app, note });
    if (!listed) return gone(`the preview ${app} is no longer on PneumaSpace: it ended itself (previews stand for ${this.opts.ttlSeconds} s), or it was discarded`);
    if (listed.manager?.name !== ours) return gone(`PneumaSpace lists an app named ${app} that ${listed.manager ? `${listed.manager.name} manages` : "nobody manages"}, not this Host (${ours}): it is not this change's preview`);
    if (listed.expiresAt === null) return gone(`PneumaSpace lists ${app} as a durable app: it is not this change's preview`);
    if (listed.status !== "registered") return gone(`the preview ${app} is ${listed.status || "not registered"} on PneumaSpace: nothing serves at its address`);
    if (listed.expiresAt <= Date.now()) return gone(`the preview ${app} reached its end at ${new Date(listed.expiresAt).toISOString()}, and PneumaSpace is ending it`);
    return { state: "standing", app, address: this.opts.space.address(app), expires_at: new Date(listed.expiresAt).toISOString() };
  }

  /**
   * Discard the preview this Host published as `id`. Without an id nothing is discarded: a discard by name alone
   * could end a later app that took the name. Never throws: a leftover preview serves a throwaway name, blocks
   * nothing and ends itself, so it is only logged.
   */
  drop(app: string, id: string | undefined): Promise<void> {
    return timed("discard the preview", () => this.discardPreview(app, id));
  }

  private async discardPreview(app: string, id: string | undefined): Promise<void> {
    const { manager, ttlSeconds, space, log } = this.opts;
    if (!id) {
      log(`preview ${app} was not discarded: this Host has no app id for it and discards a preview only by its id; it ends itself within ${ttlSeconds} s of its publish`);
      return;
    }
    if (!(await space.discard(app, manager.name, id))) {
      // Refused, or no answer. A later app that took the name is never ended in its place.
      log(`preview ${app} (app ${id}) could not be discarded from PneumaSpace; if it is still there, it ends itself within ${ttlSeconds} s of its publish, or run \`appctl discard ${app} --app ${id} --manager ${manager.name}\``);
    }
  }
}
