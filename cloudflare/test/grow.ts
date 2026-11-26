import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packFolder, unpackFolder } from "../src/folder";
import { folderKey, viewKey } from "../src/protocol";
import type { Stack } from "./stack";

/**
 * Grows an app's folder in the stack's bucket to `n` versions, as an app that lived long would have it: v3..vn are
 * copies of v2 (a whole copy of the app per version, as the record keeps them), each with one file changed and the
 * history line the Host writes for a change, built each on the one before. The folder is saved back as another writer
 * would (a new etag), its stored view removed, and the container dropped, so the next operation loads it. Returns the
 * folder's size in bytes. The app must have v1 and v2 already (created, then one change).
 */
export async function growFolder(stack: Stack, app: string, n: number): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), `appgov-grow-${app}-`));
  await unpackFolder(dir, stack.bucket.objects.get(folderKey(app))!.bytes);
  const fw = join(dir, ".pneuma-framework");
  const lines = readFileSync(join(fw, "history.jsonl"), "utf8").trim().split("\n");
  const model = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
  const started = Date.parse(String(model.at));
  const style = (k: number) => `body { background: #fafaf7; }\n/* change ${k} */\n.note-${k} { margin: ${k % 24}px; }\n`;
  for (let k = 3; k <= n; k++) {
    const to = join(fw, "versions", `v${k}`);
    cpSync(join(fw, "versions", "v2"), to, { recursive: true });
    writeFileSync(join(to, "app", "public", "style.css"), style(k));
    lines.push(JSON.stringify({ ...model, change_id: `cgrow${String(k).padStart(6, "0")}`, at: new Date(started + k * 60_000).toISOString(), intent: `Change number ${k}: a small change to the page's style`, version: `v${k}`, base_version: `v${k - 1}` }));
  }
  writeFileSync(join(fw, "history.jsonl"), `${lines.join("\n")}\n`);
  writeFileSync(join(fw, "record.json"), `${JSON.stringify({ schema_version: 1, version_counter: n, current_version: `v${n}` }, null, 2)}\n`);
  const rollout = JSON.parse(readFileSync(join(fw, "release-rollout.json"), "utf8"));
  rollout.previous = { ...rollout.active, candidate_id: `v${n - 1}`, image_tag: `${app}:v${n - 1}` };
  rollout.active = { ...rollout.active, candidate_id: `v${n}`, image_tag: `${app}:v${n}` };
  writeFileSync(join(fw, "release-rollout.json"), `${JSON.stringify(rollout, null, 2)}\n`);
  writeFileSync(join(dir, "app", "public", "style.css"), style(n));
  const tar = (await packFolder(dir))!;
  rmSync(dir, { recursive: true, force: true });
  stack.bucket.write(folderKey(app), tar);
  stack.bucket.objects.delete(viewKey(app));
  await stack.dropContainer();
  return tar.length;
}
