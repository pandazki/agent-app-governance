import { describe, expect, test } from "bun:test";
import { publishMakingRoom } from "../../host/src/room";
import type { AwakeSlots, PublishResult, SpaceRuntime } from "../../host/src/space";

const REFUSED: PublishResult = { code: 1, output: 'compute_quota: every awake slot is held\nquota {"resource":"awake"}' };
const DONE: PublishResult = { code: 0, output: "released" };
const ROOM = { waitMs: 300, pollMs: 50 };

/** A runtime whose `awake` gives each of `answers` in turn (the last one again), recording what was put to sleep. */
function runtime(answers: (AwakeSlots | Error)[]) {
  const slept: string[] = [];
  let asked = 0;
  const space = {
    awake: async () => {
      const answer = answers[Math.min(asked++, answers.length - 1)]!;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    stop: async (name: string) => void slept.push(name),
  } as unknown as SpaceRuntime;
  return { space, slept };
}

/** A publish refused `refusals` times, then done; it counts its calls. */
function publisher(refusals: number) {
  let calls = 0;
  const publish = async () => (++calls <= refusals ? REFUSED : DONE);
  return { publish, calls: () => calls };
}

describe("making room on PneumaSpace for a publish", () => {
  test("the app's own instance that holds a slot, with none free, is put to sleep, and the publish goes again", async () => {
    const { space, slept } = runtime([{ limit: 2, apps: [{ name: "todo", manager: "appgov" }, { name: "else", manager: null }] }, { limit: 2, apps: [{ name: "else", manager: null }] }]);
    const p = publisher(1);
    expect(await publishMakingRoom(space, ROOM, "appgov", "todo-pv0001", ["todo"], p.publish)).toEqual(DONE);
    expect(slept).toEqual(["todo"]);
    expect(p.calls()).toBe(2);
  });

  test("an app PneumaSpace says another manager, or none, manages is never put to sleep, even under the app's own name", async () => {
    for (const manager of ["other-host", null]) {
      const { space, slept } = runtime([{ limit: 2, apps: [{ name: "todo", manager }, { name: "else", manager: null }] }]);
      const result = await publishMakingRoom(space, ROOM, "appgov", "todo-pv0001", ["todo"], publisher(9).publish);
      expect(result.code).toBe(1);
      expect(slept).toEqual([]);
    }
  });

  test("nothing is put to sleep when PneumaSpace does not say who holds the slots, or says one is free", async () => {
    const unknown = runtime([new Error("no answer")]);
    await publishMakingRoom(unknown.space, ROOM, "appgov", "todo-pv0001", ["todo"], publisher(9).publish);
    expect(unknown.slept).toEqual([]);
    const free = runtime([{ limit: 2, apps: [{ name: "todo", manager: "appgov" }] }]);
    const p = publisher(1);
    expect(await publishMakingRoom(free.space, ROOM, "appgov", "todo-pv0001", ["todo"], p.publish)).toEqual(DONE);
    expect(free.slept).toEqual([]);
  });

  test("with no answer about the slots, the publishes are spread over the wait, three in all", async () => {
    const { space } = runtime([new Error("no answer")]);
    const p = publisher(9);
    const began = Date.now();
    const result = await publishMakingRoom(space, ROOM, "appgov", "todo-pv0001", [], p.publish);
    expect(p.calls()).toBe(3);
    expect(Date.now() - began).toBeGreaterThanOrEqual(2 * ROOM.pollMs);
    expect(result.output).toContain("PneumaSpace did not say by which apps");
  });

  test("a release does not count the app's own instance as holding a slot: its release puts that away first", async () => {
    const { space, slept } = runtime([{ limit: 2, apps: [{ name: "todo", manager: "appgov" }, { name: "else", manager: null }] }]);
    const p = publisher(1);
    expect(await publishMakingRoom(space, ROOM, "appgov", "todo", [], p.publish)).toEqual(DONE);
    expect(slept).toEqual([]);
    expect(p.calls()).toBe(2);
  });

  test("a refusal that stands names the holders other than the app itself", async () => {
    const { space } = runtime([{ limit: 2, apps: [{ name: "one", manager: "appgov" }, { name: "two", manager: null }] }]);
    const result = await publishMakingRoom(space, ROOM, "appgov", "todo-pv0001", ["todo"], publisher(9).publish);
    expect(result.output).toContain("awake slots: all 2 awake slots of the workspace are held, by one (managed by this Host) and two (not managed by this Host); this Host waited");
  });
});
