import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppHost } from "../../host/src/host";
import { loadRiskPolicy, type GovernanceMode } from "../../host/src/policy";
import type { SpaceRuntime } from "../../host/src/space";
import type { CheckRun } from "../../host/src/test-coverage";

/** This edition's directory: its overlay, template, risk preset and CLI. */
export const EDITION = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const TEMPLATE = join(EDITION, "template");

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
    ...(opts.runVerify ? { runVerify: opts.runVerify } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  });
}
