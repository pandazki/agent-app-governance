import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppHost } from "../../host/src/host";
import { loadRiskPolicy, type GovernanceMode } from "../../host/src/policy";
import type { SpaceRuntime } from "../../host/src/space";
import type { AppLayout, CheckRun } from "../../host/src/test-coverage";

/** This edition's directory: its overlay, template, risk preset and CLI. */
export const EDITION = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const TEMPLATE = join(EDITION, "template");

/**
 * Where an app made from this edition's template keeps its own code and tests: everything the platform runs is under
 * app/, and the tests are *.test.mjs files under tests/. The template ships no vendored part, so every test that ran
 * is the app's own.
 */
export const CF_LAYOUT: AppLayout = { code_roots: ["app/"], test_dir: "tests", test_file: "*.test.mjs" };

export interface EditionHostOptions {
  readonly appsDir: string;
  readonly space: SpaceRuntime;
  readonly owner: string;
  readonly governance: GovernanceMode;
  readonly manager: { readonly name: string; readonly url?: string };
  readonly previewTtlSeconds: number;
  readonly preview?: boolean;
  readonly runVerify?: (root: string, command: string) => Promise<CheckRun>;
  readonly log?: (line: string) => void;
}

/** The shared Host with what this edition brings: its overlay, its CLI and its risk preset. */
export function editionHost(opts: EditionHostOptions): AppHost {
  return new AppHost({
    appsDir: opts.appsDir,
    space: opts.space,
    overlayDir: join(EDITION, "overlay"),
    cliSource: join(EDITION, "bin", "appgov.mjs"),
    owner: opts.owner,
    governance: opts.governance,
    policy: loadRiskPolicy(join(EDITION, "policy", "personal.json")),
    preview: opts.preview ?? true,
    previewTtlSeconds: opts.previewTtlSeconds,
    manager: opts.manager,
    layout: CF_LAYOUT,
    ...(opts.runVerify ? { runVerify: opts.runVerify } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  });
}
