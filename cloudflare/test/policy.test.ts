import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSpaceManifest, sourceDiff } from "../../host/src/artifact";
import { classifyRisks, loadRiskPolicy } from "../../host/src/policy";
import { EDITION, TEMPLATE } from "../src/edition";

// This edition's preset on the shared classification: what an agent's change to a pneuma-space.cf/1 app carries.
const policy = loadRiskPolicy(join(EDITION, "policy", "personal.json"));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** `base` makes the active version from the template; the draft starts as that version and gets `change`. */
function assess(change: (draft: string) => void, base: (active: string) => void = () => {}) {
  const active = mkdtempSync(join(tmpdir(), "cf-policy-a-"));
  const draft = mkdtempSync(join(tmpdir(), "cf-policy-d-"));
  dirs.push(active, draft);
  cpSync(TEMPLATE, active, { recursive: true });
  base(active);
  cpSync(active, draft, { recursive: true });
  change(draft);
  return classifyRisks(policy, { diff: sourceDiff(active, draft), activeRoot: active, draftRoot: draft, before: readSpaceManifest(active), after: readSpaceManifest(draft) });
}

const manifest = (draft: string, edit: (m: { capabilities: Record<string, unknown> }) => void) => {
  const m = readSpaceManifest(draft) as { capabilities: Record<string, unknown> };
  edit(m);
  writeFileSync(join(draft, "pneuma-space.json"), JSON.stringify(m));
};

describe("the Cloudflare edition's risk preset", () => {
  test("a change to the page shell only is additive_ui, which the standing rule approves", () => {
    const result = assess((d) => writeFileSync(join(d, "app", "public", "style.css"), "body{}\n"));
    expect(result.risks).toEqual(["additive_ui"]);
  });

  test("a change to the server is source_code_change", () => {
    const result = assess((d) => writeFileSync(join(d, "app", "server.mjs"), "export {}\n"));
    expect(result.risks).toEqual(["source_code_change"]);
  });

  test("identity.required dropped to a bare identity, or identity removed, is sign-in dropped: policy_change", () => {
    expect(assess((d) => manifest(d, (m) => (m.capabilities.identity = {}))).risks).toContain("policy_change");
    expect(assess((d) => manifest(d, (m) => (m.capabilities.identity = { required: false }))).risks).toContain("policy_change");
    expect(assess((d) => manifest(d, (m) => delete m.capabilities.identity)).risks).toContain("policy_change");
  });

  test("declaring identity without required on this contract was never a sign-in requirement", () => {
    const active = mkdtempSync(join(tmpdir(), "cf-policy-a-"));
    const draft = mkdtempSync(join(tmpdir(), "cf-policy-d-"));
    dirs.push(active, draft);
    cpSync(TEMPLATE, active, { recursive: true });
    manifest(active, (m) => (m.capabilities.identity = {}));
    cpSync(active, draft, { recursive: true });
    manifest(draft, (m) => (m.capabilities.db = {}));
    const result = classifyRisks(policy, { diff: sourceDiff(active, draft), activeRoot: active, draftRoot: draft, before: readSpaceManifest(active), after: readSpaceManifest(draft) });
    expect(result.risks).not.toContain("policy_change");
  });

  test("replacing kv with db, as the trial's agent did, is not additive: dropping kv waits for the owner and is one-way", () => {
    const result = assess((d) =>
      manifest(d, (m) => {
        delete m.capabilities.kv;
        m.capabilities.db = {};
      }),
    );
    expect(result.risks).toContain("destructive_definition");
    expect(policy.auto_approve).not.toContain("destructive_definition");
    expect(result.reasons).toContain("stops declaring kv, where it keeps stored data");
    expect(result.oneWay).toEqual([
      "The app stops declaring kv, where it keeps stored data. PneumaSpace keeps that data, but this version cannot reach it, and what the app stores from now on goes elsewhere; going back to an earlier version would not bring that along.",
    ]);
    expect(result.disclosure).toEqual(result.oneWay);
  });

  test("dropping a capability that keeps no data (static) is not a storage removal", () => {
    const result = assess((d) => manifest(d, (m) => delete m.capabilities.static));
    expect(result.risks).not.toContain("destructive_definition");
    expect(result.oneWay).toEqual([]);
  });

  test("a job declared with its file, dropped, or given another schedule carries only risks the standing rule approves", () => {
    const withJob = (dir: string, schedule: string) => {
      manifest(dir, (m) => (m.capabilities.cron = { triggers: { digest: { schedule } } }));
      mkdirSync(join(dir, "app", "jobs"), { recursive: true });
      writeFileSync(join(dir, "app", "jobs", "digest.mjs"), "export default async function () {}\n");
    };
    const added = assess((d) => withJob(d, "0 6 * * *"));
    expect([...added.risks].sort()).toEqual(["definition_additive", "source_code_change"]);
    expect(added.reasons).toContain("declares capability cron");
    const dropped = assess(
      (d) => {
        manifest(d, (m) => delete m.capabilities.cron);
        rmSync(join(d, "app", "jobs"), { recursive: true });
      },
      (a) => withJob(a, "0 6 * * *"),
    );
    expect([...dropped.risks].sort()).toEqual(["release_change", "source_code_change"]);
    expect(dropped.oneWay).toEqual([]);
    const rescheduled = assess((d) => withJob(d, "30 7 * * 1"), (a) => withJob(a, "0 6 * * *"));
    expect(rescheduled.risks).toEqual(["source_code_change"]);
    for (const { risks } of [added, dropped, rescheduled]) expect(risks.every((risk) => policy.auto_approve.includes(risk))).toBe(true);
  });

  test("new SQL that drops a table is destructive and one-way", () => {
    const result = assess((d) => writeFileSync(join(d, "app", "server.mjs"), "await native({type:'db.query',sql:'DROP TABLE items',params:[]});\n"));
    expect(result.risks).toContain("destructive_definition");
    expect(result.oneWay.length).toBe(1);
  });
});
