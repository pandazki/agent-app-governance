import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PageAssets } from "./page-views";

// The owner page as the local edition's Host serves it: every view's model and the HTML around it come from
// page-views.ts, which the Cloudflare edition's Worker shares; this file adds what needs the machine's disk.
export * from "./page-views";

export function loadPageAssets(dir = join(import.meta.dir, "..", "web", "dist")): PageAssets {
  const files = new Map<string, string>();
  for (const name of ["app.js", "app.css"]) {
    const path = join(dir, name);
    if (existsSync(path)) files.set(name, createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 12));
  }
  return { dir, files };
}
