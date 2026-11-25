import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GOVERNANCE_MODES, type GovernanceMode } from "../../host/src/policy";
import { DEFAULT_MANAGER, SPACE_NAME } from "../../host/src/space";
import { EDITION, editionHost, TEMPLATE } from "./edition";
import { OWNER_SUBJECT } from "./protocol";
import { createContainerServer } from "./server";
import { CfSpace } from "./space-cf";
import { socketSupervisor, supervisedVerify } from "./verify";

// Entry point of the Host inside the container: `bun run src/serve.ts`, started as the user `host` by
// container/supervisor.mjs. Everything it needs arrives in its environment from the app's Durable Object.

const env = process.env;
const need = (name: string): string => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is not set; the Durable Object passes it when it starts the container`);
  return value;
};

const secret = need("APPGOV_CONTAINER_SECRET");
const token = need("APPGOV_SPACE_TOKEN");
// Nothing this process starts needs them: tar, and the supervisor, which has its own environment.
delete env.APPGOV_CONTAINER_SECRET;
delete env.APPGOV_SPACE_TOKEN;

const governance = (env.APPGOV_GOVERNANCE?.trim() || "personal") as GovernanceMode;
if (!GOVERNANCE_MODES.includes(governance)) throw new Error(`APPGOV_GOVERNANCE must be ${GOVERNANCE_MODES.join(", ")}`);
const manager = env.APPGOV_MANAGER?.trim() || DEFAULT_MANAGER;
if (!SPACE_NAME.test(manager)) throw new Error(`APPGOV_MANAGER must be a name PneumaSpace accepts, not "${manager}"`);
const managerUrl = env.APPGOV_MANAGER_URL?.trim();
const appsDir = env.APPGOV_APPS_DIR?.trim() || "/data/apps";
const ownerSubject = env.APPGOV_OWNER?.trim() || OWNER_SUBJECT;
const log = (line: string) => console.log(`[host] ${line}`);
mkdirSync(appsDir, { recursive: true });

const host = editionHost({
  appsDir,
  space: new CfSpace({ origin: need("APPGOV_SPACE_ORIGIN"), token, template: TEMPLATE }),
  owner: ownerSubject,
  governance,
  manager: { name: manager, ...(managerUrl ? { url: managerUrl } : {}) },
  previewTtlSeconds: Number(env.APPGOV_PREVIEW_TTL?.trim() || 3600),
  preview: env.APPGOV_PREVIEW !== "off",
  runVerify: supervisedVerify(socketSupervisor(env.APPGOV_SUPERVISOR_SOCKET?.trim() || "/run/appgov/supervisor.sock")),
  log,
});

/** A short hash of the Host's code in this image, so that `container` can say which build runs. */
function buildId(): string {
  const hash = createHash("sha256");
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) hash.update(path).update(readFileSync(path));
    }
  };
  for (const dir of [join(EDITION, "..", "host", "src"), join(EDITION, "src"), join(EDITION, "bin"), join(EDITION, "container")]) walk(dir);
  return hash.digest("hex").slice(0, 12);
}

const port = Number(env.APPGOV_HOST_PORT ?? 8080);
createContainerServer({ host, appsDir, secret, ownerSubject, build: buildId(), log }).listen(port, "0.0.0.0", () => {
  log(`listening on ${port}; ${governance} mode; manager ${manager}; apps in ${appsDir}`);
});
