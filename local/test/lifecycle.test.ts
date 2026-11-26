import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AppHost, HostError, type AppHostOptions, type HostDataSnapshot } from "../../host/src/host";
import { choicesFor, downOf, runtimeFacts, standingOf } from "../../host/src/lifecycle";
import { AUTO_SUBJECT, loadRiskPolicy } from "../../host/src/policy";
import { FakeSpace } from "./fake-space";

// Whether an app is there (host/src/lifecycle.ts and the Host's take down, bring back, publish again and clear), in
// the shared code both editions run: each state and transition, who may act, what is refused while an app is not
// there, and what clearing deletes with a runtime that may purge (the local gateway) and one that may not (the
// Cloudflare plane, `purges = false`).

const EXAMPLE = join(import.meta.dir, "..");
const OWNER = "user:me";
const POLICY = loadRiskPolicy(join(EXAMPLE, "policy", "personal.json"));

let work: string;
let space: FakeSpace;
let host: AppHost;

function makeHost(fake: FakeSpace, extra: Partial<AppHostOptions> = {}): AppHost {
  return new AppHost({
    appsDir: join(work, "apps"),
    space: fake,
    overlayDir: join(EXAMPLE, "overlay"),
    cliSource: join(EXAMPLE, "bin", "appgov.mjs"),
    owner: OWNER,
    policy: POLICY,
    runVerify: async (root) => (existsSync(join(root, "src", "TEST_FAILS")) ? { ok: false, output: "1 test failed" } : { ok: true, output: "tests passed" }),
    ...extra,
  });
}
const app = (...rel: string[]) => join(work, "apps", "todo", ...rel);
const edit = (rel: string, content: string) => {
  mkdirSync(dirname(app(rel)), { recursive: true });
  writeFileSync(app(rel), content);
};
async function refusal(promise: Promise<unknown>): Promise<HostError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof HostError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}
const owner = (extra: Record<string, string> = {}) => ({ subject: OWNER, ...extra });
const kinds = () => host.history("todo").map((entry) => entry.kind);

beforeEach(async () => {
  work = mkdtempSync(join(tmpdir(), "aag-life-"));
  space = new FakeSpace();
  host = makeHost(space);
  await host.create("todo");
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

describe("what the two facts mean together", () => {
  const at = new Date("2026-11-26T10:00:00Z");
  const serving = runtimeFacts({ app: { name: "todo", status: "registered", expiresAt: null, manager: null } }, at);
  const removed = runtimeFacts({ app: { name: "todo", status: "removed", expiresAt: null, manager: null } }, at);
  const gone = runtimeFacts({ app: null }, at);
  const unknown = runtimeFacts({ error: new Error("PneumaSpace admin answered 502") }, at);
  const down = { at: "2026-11-25T09:00:00Z", by: OWNER };

  test("PneumaSpace's answer is a fact with its time; one being purged counts as gone", () => {
    expect(serving).toEqual({ state: "serving", checked_at: "2026-11-26T10:00:00.000Z" });
    expect(removed.state).toBe("removed");
    expect(gone.state).toBe("gone");
    expect(runtimeFacts({ app: { name: "todo", status: "purging", expiresAt: null, manager: null } }, at).state).toBe("gone");
    expect(unknown).toMatchObject({ state: "unknown", note: "PneumaSpace admin answered 502" });
  });

  test("the last take down, bring back or publish again in the history decides whether the owner took it down", () => {
    const entry = (kind: string, at: string) => ({ kind, at, agent: OWNER });
    expect(downOf([entry("create", "1"), entry("change", "2")])).toBeNull();
    expect(downOf([entry("take_down", "3"), entry("change", "4")])).toEqual({ at: "3", by: OWNER });
    expect(downOf([entry("take_down", "3"), entry("bring_back", "5")])).toBeNull();
    expect(downOf([entry("take_down", "3"), entry("publish_again", "6"), entry("take_down", "7")])).toEqual({ at: "7", by: OWNER });
  });

  test("each standing, and what the owner may do in it: nothing on a guess, clearing never from serving", () => {
    expect(standingOf(null, serving)).toBe("running");
    expect(standingOf(null, removed)).toBe("removed_elsewhere");
    expect(standingOf(null, gone)).toBe("vanished");
    expect(standingOf(null, unknown)).toBe("unconfirmed");
    expect(standingOf(down, removed)).toBe("down");
    expect(choicesFor("running", serving)).toEqual({ take_down: true, bring_back: false, publish_again: false, clear: false });
    expect(choicesFor("down", removed)).toEqual({ take_down: false, bring_back: true, publish_again: false, clear: true });
    expect(choicesFor("down", gone)).toEqual({ take_down: false, bring_back: false, publish_again: true, clear: true });
    expect(choicesFor("down", serving)).toEqual({ take_down: true, bring_back: true, publish_again: false, clear: false });
    expect(choicesFor("removed_elsewhere", removed)).toEqual({ take_down: false, bring_back: true, publish_again: false, clear: true });
    expect(choicesFor("vanished", gone)).toEqual({ take_down: false, bring_back: false, publish_again: true, clear: true });
    expect(choicesFor("unconfirmed", unknown)).toEqual({ take_down: false, bring_back: false, publish_again: false, clear: false });
    expect(choicesFor("down", unknown)).toEqual({ take_down: false, bring_back: false, publish_again: false, clear: false });
  });
});

describe("taking an app down and bringing it back", () => {
  test("only the owner takes it down; PneumaSpace keeps it removed with its data; the history says who", async () => {
    expect(await refusal(host.takeDown("todo", { subject: "agent:codex" }))).toMatchObject({ status: 403, reason: "owner_required" });
    expect(await refusal(host.takeDown("todo", { subject: AUTO_SUBJECT }))).toMatchObject({ status: 403, reason: "owner_required" });
    const id = space.live.get("todo")!.id;
    const result = await host.takeDown("todo", owner({ channel: "owner-page" }));

    expect(result).toMatchObject({ app: "todo", standing: "down", runtime: { state: "removed" }, taken_down: { by: OWNER, channel: "owner-page" } });
    expect(space.live.get("todo")).toMatchObject({ status: "removed", id });
    expect(host.history("todo").at(-1)).toMatchObject({ kind: "take_down", agent: OWNER, outcome: "taken_down", control: "owner", channel: "owner-page", guarantees: [] });
    expect(await host.status("todo")).toMatchObject({ standing: "down", choices: { bring_back: true, clear: true, take_down: false } });
    expect((await host.summaries())[0]).toMatchObject({ app_id: "todo", standing: "down", last_change: { kind: "take_down" } });
    // Taking it down twice is refused, saying it is down already.
    expect(await refusal(host.takeDown("todo", owner()))).toMatchObject({ status: 409, reason: "cannot_take_down" });
  });

  test("while it is down, a submit, an approval and an undo are refused, saying the owner took it down, and nothing is recorded", async () => {
    edit("src/ordinary.ts", "export const ordinary = 1;\n");
    await host.submit({ name: "todo", intent: "an ordinary change", agent: "codex" });
    edit("src/server.ts", "export const sql = `ALTER TABLE todos DROP COLUMN note`;\n");
    const waiting = await host.submit({ name: "todo", intent: "remove notes", agent: "claude-code" });
    expect(waiting.status).toBe("needs_approval");
    await host.takeDown("todo", owner());
    const before = kinds().length;

    edit("src/extra.ts", "export const extra = 1;\n");
    const submit = await refusal(host.submit({ name: "todo", intent: "add", agent: "codex" }));
    expect(submit).toMatchObject({ status: 409, reason: "app_down", fields: { taken_down_by: OWNER } });
    expect(submit.message).toMatch(/^todo is taken down: user:me took it down on \d{4}-\d\d-\d\d\. It serves nothing and takes no changes until the owner brings it back\. Nothing was checked, recorded or released\./);
    rmSync(app("src", "extra.ts"));
    expect(await refusal(host.resolve("todo", waiting.change_id, "approved", OWNER))).toMatchObject({ status: 409, reason: "app_down" });
    // The waiting change keeps its own draft; the working tree goes back to the current version before undoing.
    await host.discard("todo");
    expect(await refusal(host.undo("todo", "back"))).toMatchObject({ status: 409, reason: "app_down" });
    expect(kinds()).toHaveLength(before);
    expect(space.live.get("todo")!.status).toBe("removed");
  });

  test("bringing it back serves the same app again, with the data PneumaSpace kept, and changes go through again", async () => {
    const id = space.live.get("todo")!.id;
    await host.takeDown("todo", owner());
    expect(await refusal(host.bringBack("todo", { subject: "agent:codex" }))).toMatchObject({ status: 403, reason: "owner_required" });
    const back = await host.bringBack("todo", owner({ reason: "needed again" }));

    expect(back).toMatchObject({ standing: "running", taken_down: null, note: "todo is back: it serves v1 again, with the data PneumaSpace kept." });
    expect(space.live.get("todo")).toMatchObject({ status: "registered", id });
    expect(host.history("todo").at(-1)).toMatchObject({ kind: "bring_back", intent: "Bring todo back: needed again", agent: OWNER, outcome: "brought_back" });
    edit("src/extra.ts", "export const extra = 1;\n");
    expect(await host.submit({ name: "todo", intent: "add", agent: "codex" })).toMatchObject({ status: "published", version: "v2" });
    expect(await refusal(host.bringBack("todo", owner()))).toMatchObject({ status: 409, reason: "cannot_bring_back" });
  });

  test("an app removed on PneumaSpace behind the Host's back is not running either, and can be brought back", async () => {
    space.setStatus("todo", "removed");
    expect(await host.status("todo")).toMatchObject({ standing: "removed_elsewhere", taken_down: null, choices: { bring_back: true, clear: true } });
    edit("src/extra.ts", "export const extra = 1;\n");
    expect(await refusal(host.submit({ name: "todo", intent: "add", agent: "codex" }))).toMatchObject({ status: 409, reason: "app_removed_elsewhere" });
    await host.bringBack("todo", owner());
    expect(await host.submit({ name: "todo", intent: "add", agent: "codex" })).toMatchObject({ status: "published" });
  });

  test("a PneumaSpace that does not answer is said so, and nothing is offered or done on a guess", async () => {
    space.unreachable = true;
    expect(await host.status("todo")).toMatchObject({ standing: "unconfirmed", runtime: { state: "unknown" }, choices: { take_down: false, clear: false } });
    expect(await refusal(host.takeDown("todo", owner()))).toMatchObject({ status: 502, reason: "space_unknown" });
    expect(await refusal(host.clear("todo", { ...owner(), confirm: "todo" }))).toMatchObject({ status: 502, reason: "space_unknown" });
    expect(kinds()).toEqual(["create"]);
  });
});

describe("an app that vanished behind the Host's back", () => {
  test("status says it is not on PneumaSpace; a submit, an approval and an undo are refused and create nothing", async () => {
    edit("src/extra.ts", "export const extra = 1;\n");
    await host.submit({ name: "todo", intent: "add", agent: "codex" });
    space.vanish("todo");

    expect(await host.status("todo")).toMatchObject({ standing: "vanished", runtime: { state: "gone" }, choices: { publish_again: true, clear: true, bring_back: false }, space_manager: { state: "absent" } });
    edit("src/more.ts", "export const more = 1;\n");
    const submit = await refusal(host.submit({ name: "todo", intent: "more", agent: "codex" }));
    expect(submit).toMatchObject({ status: 409, reason: "app_vanished" });
    expect(submit.message).toContain("PneumaSpace has no app named todo any more, and this Host did not take it down, so the data it stored there is gone.");
    expect(submit.message).toContain("The owner chooses: publish it again from v2 (it starts with no stored data), or clear this Host's record of it.");
    rmSync(app("src", "more.ts"));
    expect(await refusal(host.undo("todo", "back"))).toMatchObject({ status: 409, reason: "app_vanished" });
    expect(space.live.has("todo")).toBe(false);
    expect(kinds()).toEqual(["create", "change"]);
  });

  test("publishing it again is the owner's, creates it anew from the current version, and says its data is not there", async () => {
    edit("src/extra.ts", "export const extra = 1;\n");
    await host.submit({ name: "todo", intent: "add", agent: "codex" });
    const before = space.live.get("todo")!.id;
    space.vanish("todo");
    expect(await refusal(host.publishAgain("todo", { subject: "agent:codex" }))).toMatchObject({ status: 403, reason: "owner_required" });
    const again = await host.publishAgain("todo", owner({ channel: "owner-page" }));

    expect(again).toMatchObject({ standing: "running", note: "todo is on PneumaSpace again, serving v2, with no stored data: what it stored there before is not there any more." });
    expect(space.live.get("todo")!.id).not.toBe(before);
    expect(space.live.get("todo")!.files).toContain("src/extra.ts");
    expect(host.history("todo").at(-1)).toMatchObject({ kind: "publish_again", agent: OWNER, channel: "owner-page", note: expect.stringContaining("not there any more") });
    // Only for an app PneumaSpace no longer has.
    expect(await refusal(host.publishAgain("todo", owner()))).toMatchObject({ status: 409, reason: "cannot_publish_again" });
  });
});

describe("clearing an app", () => {
  test("never from serving, never without the name typed, and only by the owner", async () => {
    expect(await refusal(host.clear("todo", { ...owner(), confirm: "todo" }))).toMatchObject({ status: 409, reason: "clear_running" });
    await host.takeDown("todo", owner());
    expect(await refusal(host.clear("todo", { subject: "agent:codex", confirm: "todo" }))).toMatchObject({ status: 403, reason: "owner_required" });
    expect(await refusal(host.clear("todo", { ...owner(), confirm: "" }))).toMatchObject({ status: 400, reason: "confirm_name" });
    expect(await refusal(host.clear("todo", { ...owner(), confirm: "Todo" }))).toMatchObject({ status: 400, reason: "confirm_name" });
    expect(existsSync(app())).toBe(true);
    expect(space.live.get("todo")!.status).toBe("removed");
  });

  test("where the runtime may purge (the local gateway): the record goes, and the app with its data on PneumaSpace", async () => {
    await host.takeDown("todo", owner());
    const status = await host.status("todo");
    expect(status.clearing).toMatchObject({ purges: true, snapshots: [] });
    expect(status.clearing.deletes).toEqual([
      "the folder todo on this Host, the one agents work in, with its files, its versions, its history and the changes that wait for the owner, with their previews",
      "todo on PneumaSpace, with all its stored data (purged): this cannot be undone",
    ]);
    const cleared = await host.clear("todo", { ...owner(), confirm: "todo" });

    expect(cleared).toMatchObject({ app: "todo", cleared: true, space_holds: false, deleted: status.clearing.deletes });
    expect(existsSync(app())).toBe(false);
    expect(space.live.has("todo")).toBe(false);
    expect(space.log).toContain("purge todo");
    expect(host.list()).toEqual([]);
  });

  test("a purge that goes through without an answer in time still clears; one PneumaSpace refuses clears nothing", async () => {
    await host.takeDown("todo", owner());
    space.purgeRefuses = true;
    expect(await refusal(host.clear("todo", { ...owner(), confirm: "todo" }))).toMatchObject({ status: 502, reason: "space_refused" });
    expect(existsSync(app())).toBe(true);
    expect(space.live.get("todo")!.status).toBe("removed");
    space.purgeRefuses = false;
    space.purgeUnanswered = true;
    expect(await host.clear("todo", { ...owner(), confirm: "todo" })).toMatchObject({ cleared: true, space_holds: false });
    expect(existsSync(app())).toBe(false);
    expect(space.live.has("todo")).toBe(false);
  });

  test("where it may not (the Cloudflare plane): the record goes, and PneumaSpace keeps the app removed with its data, as the confirmation said", async () => {
    space.purges = false;
    await host.takeDown("todo", owner());
    const status = await host.status("todo");
    expect(status.clearing.purges).toBe(false);
    expect(status.clearing.deletes).toEqual(["the folder todo on this Host, the one agents work in, with its files, its versions, its history and the changes that wait for the owner, with their previews"]);
    expect(status.clearing.keeps[0]).toBe(
      "todo on PneumaSpace, removed, with all its stored data: this Host may not purge it there. Its name, its app slot and its storage stay taken until the PneumaSpace owner purges it in PneumaSpace's console",
    );
    const cleared = await host.clear("todo", { ...owner(), confirm: "todo" });

    expect(cleared).toMatchObject({ cleared: true, space_holds: true, kept: status.clearing.keeps });
    expect(existsSync(app())).toBe(false);
    expect(space.live.get("todo")!.status).toBe("removed");
    expect(space.log).not.toContain("purge todo");
  });

  test("an app that vanished is cleared without anything on PneumaSpace; a change that waits loses its preview", async () => {
    edit("src/server.ts", "export const sql = `ALTER TABLE todos DROP COLUMN note`;\n");
    const waiting = await host.submit({ name: "todo", intent: "remove notes", agent: "claude-code" });
    expect(waiting.status).toBe("needs_approval");
    const preview = space.previews()[0]!;
    space.vanish("todo");
    expect((await host.status("todo")).clearing.keeps).toContain("nothing on PneumaSpace: it has no app named todo any more");
    await host.clear("todo", { ...owner(), confirm: "todo" });

    expect(existsSync(app())).toBe(false);
    expect(space.live.has(preview)).toBe(false);
  });

  test("the data snapshots this Host made are named, and kept", async () => {
    const snapshots: HostDataSnapshot = { id: "fake-snapshot", snapshot: async () => ({ ref: "snap-1" }), restore: async () => {} };
    host = makeHost(space, { dataSnapshot: snapshots });
    edit("src/server.ts", "export const sql = `ALTER TABLE todos DROP COLUMN note`;\n");
    const waiting = await host.submit({ name: "todo", intent: "remove notes", agent: "claude-code" });
    await host.resolve("todo", waiting.change_id, "approved", OWNER);
    await host.takeDown("todo", owner());
    const status = await host.status("todo");

    expect(status.clearing.snapshots).toEqual(["snap-1"]);
    expect(status.clearing.discards_snapshots).toBe(false);
    expect(status.clearing.keeps).toContain("the data snapshots this Host made of todo (snap-1), where fake-snapshot keeps them: clearing does not delete them");
    // Not asked, since it cannot be: the clear goes through and says what stays.
    const cleared = await host.clear("todo", { ...owner(), confirm: "todo" });
    expect(cleared.data_discarded).toBeUndefined();
    expect(cleared.kept).toContain("the data snapshots this Host made of todo (snap-1), where fake-snapshot keeps them: clearing does not delete them");
  });

  /** A capability that can be asked to let go, writing what it is asked into the fake's log, so its order beside the purge shows. */
  function letting(fail = false): HostDataSnapshot & { held: string[] } {
    const held: string[] = [];
    return {
      id: "fake-snapshot",
      held,
      snapshot: async () => {
        held.push(`snap-${held.length + 1}`);
        return { ref: held.at(-1)! };
      },
      restore: async () => {},
      discardAll: async ({ refs }) => {
        space.log.push(`discardAll ${refs.join(",")}`);
        if (fail) throw new Error("dropped snap-0, but could not drop snap-1 (the server went away)");
        return { discarded: held.splice(0), refused: [] };
      },
    };
  }

  test("a capability that can let go is asked, with every ref in the history, before PneumaSpace purges the app; the confirmation says so", async () => {
    const cap = letting();
    host = makeHost(space, { dataSnapshot: cap });
    edit("src/server.ts", "export const sql = `ALTER TABLE todos DROP COLUMN note`;\n");
    const waiting = await host.submit({ name: "todo", intent: "remove notes", agent: "claude-code" });
    await host.resolve("todo", waiting.change_id, "approved", OWNER);
    await host.takeDown("todo", owner());
    const status = await host.status("todo");

    expect(status.clearing).toMatchObject({ snapshots: ["snap-1"], snapshot_capability: "fake-snapshot", discards_snapshots: true });
    expect(status.clearing.deletes).toContain("the data snapshots this Host made of todo (snap-1), with the data its undos set aside, where fake-snapshot keeps them: fake-snapshot lets go of them first");
    expect(status.clearing.keeps.join(" ")).not.toContain("snap-1");

    space.log.length = 0;
    const cleared = await host.clear("todo", { ...owner(), confirm: "todo" });
    expect(cleared).toMatchObject({ cleared: true, space_holds: false, data_discarded: ["snap-1"] });
    expect(space.log.filter((line) => line.startsWith("discardAll") || line.startsWith("purge"))).toEqual(["discardAll snap-1", "purge todo"]);
    expect(cap.held).toEqual([]);
    expect(existsSync(app())).toBe(false);
  });

  test("when the capability cannot let go, nothing else is cleared: no purge, the record stays, and clearing again asks again", async () => {
    host = makeHost(space, { dataSnapshot: letting(true) });
    edit("src/server.ts", "export const sql = `ALTER TABLE todos DROP COLUMN note`;\n");
    const waiting = await host.submit({ name: "todo", intent: "remove notes", agent: "claude-code" });
    await host.resolve("todo", waiting.change_id, "approved", OWNER);
    await host.takeDown("todo", owner());
    space.log.length = 0;

    const err = await refusal(host.clear("todo", { ...owner(), confirm: "todo" }));
    expect(err).toMatchObject({ status: 502, reason: "data_snapshot_discard_failed" });
    expect(err.message).toBe(
      "fake-snapshot could not let go of what it saved of todo (dropped snap-0, but could not drop snap-1 (the server went away)). Nothing else was cleared: todo is still taken down, with its data, and this Host keeps its record, so clearing again tries again.",
    );
    expect(space.log.some((line) => line.startsWith("purge"))).toBe(false);
    expect(existsSync(app())).toBe(true);
    expect((await host.status("todo")).standing).toBe("down");
  });

  test("a purge that fails after the capability let go says what is already gone", async () => {
    host = makeHost(space, { dataSnapshot: letting() });
    edit("src/server.ts", "export const sql = `ALTER TABLE todos DROP COLUMN note`;\n");
    const waiting = await host.submit({ name: "todo", intent: "remove notes", agent: "claude-code" });
    await host.resolve("todo", waiting.change_id, "approved", OWNER);
    await host.takeDown("todo", owner());
    space.purgeRefuses = true;

    const err = await refusal(host.clear("todo", { ...owner(), confirm: "todo" }));
    expect(err).toMatchObject({ status: 502, reason: "space_refused" });
    expect(err.message).toBe(
      "PneumaSpace did not purge todo (it refused or did not answer). Nothing else was cleared; todo is still taken down, with its data. fake-snapshot has already dropped what it saved of todo (snap-1).",
    );
    expect(existsSync(app())).toBe(true);
  });
});

describe("stored facts restated from a newer listing of PneumaSpace (the Cloudflare edition's reads)", () => {
  const listing = (at: string, apps: Record<string, string>) => ({ checked_at: at, apps });
  const runningStatus = {
    app_id: "todo",
    runtime: { state: "serving", checked_at: "2026-11-26T10:00:00.000Z" },
    taken_down: null,
    standing: "running",
    choices: { take_down: true, bring_back: false, publish_again: false, clear: false },
    clearing: { purges: false, snapshots: [] as string[], snapshot_capability: null, discards_snapshots: false, copies_apart: true, deletes: [] as string[], keeps: [] as string[] },
  };

  test("a newer listing without the app makes a stored 'running' vanished, with what the owner may do and what clearing leaves", async () => {
    const { restated } = await import("../../host/src/lifecycle");
    const out = restated(runningStatus, "todo", listing("2026-11-26T10:05:00.000Z", { other: "registered" }), true);
    expect(out).toMatchObject({ standing: "vanished", runtime: { state: "gone", checked_at: "2026-11-26T10:05:00.000Z" }, choices: { publish_again: true, clear: true, take_down: false } });
    expect(out.clearing.keeps).toContain("nothing on PneumaSpace: it has no app named todo any more");
  });

  test("restated, the clearing words keep saying whether the capability lets go of the snapshots", async () => {
    const { restated } = await import("../../host/src/lifecycle");
    const down = {
      ...runningStatus,
      taken_down: { at: "2026-11-26T09:30:00.000Z", by: OWNER },
      standing: "down",
      clearing: { ...runningStatus.clearing, purges: true, snapshots: ["snap-1"], snapshot_capability: "fake-snapshot", discards_snapshots: true },
    };
    const out = restated(down, "todo", listing("2026-11-26T10:05:00.000Z", { todo: "removed" }), true);
    expect(out.clearing).toMatchObject({ discards_snapshots: true });
    expect(out.clearing.deletes.join(" ")).toContain("fake-snapshot lets go of them first");
    const kept = restated({ ...down, clearing: { ...down.clearing, discards_snapshots: false } }, "todo", listing("2026-11-26T10:05:00.000Z", { todo: "removed" }), true);
    expect(kept.clearing.keeps.join(" ")).toContain("clearing does not delete them");
  });

  test("an older listing changes nothing; a removed app the owner took down stays down", async () => {
    const { restated } = await import("../../host/src/lifecycle");
    expect(restated(runningStatus, "todo", listing("2026-11-26T09:00:00.000Z", {}), true)).toBe(runningStatus);
    const down = { ...runningStatus, taken_down: { at: "2026-11-26T09:30:00.000Z", by: OWNER }, standing: "down", runtime: { state: "removed", checked_at: "2026-11-26T10:00:00.000Z" } };
    expect(restated(down, "todo", listing("2026-11-26T10:05:00.000Z", { todo: "removed" }), true)).toMatchObject({ standing: "down", choices: { bring_back: true, clear: true } });
  });

  test("a summary stored by a Host from before these fields takes the listing alone", async () => {
    const { restated } = await import("../../host/src/lifecycle");
    const old = { app_id: "todo", active_version: "v3" };
    expect(restated(old, "todo", listing("2026-11-26T10:05:00.000Z", {}))).toMatchObject({ standing: "vanished", runtime: { state: "gone" } });
    expect(restated(old, "todo", listing("2026-11-26T10:05:00.000Z", { todo: "registered" }))).toMatchObject({ standing: "running" });
    expect(restated(old, "todo", listing("2026-11-26T10:05:00.000Z", {}), true)).toMatchObject({ choices: { publish_again: true, clear: true } });
    expect(restated(old, "todo", null)).toBe(old);
  });
});
