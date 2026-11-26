import type { AddressInfo } from "node:net";
import { hostFromEnv, hostStateDir, hostUrlFromEnv, picturesFromEnv } from "./config";
import { ownerLink, ownerTokenIn } from "./owner";
import { createHostServer } from "./server";

// Entry point of the served (agent-driven) Host: `bun run src/serve.ts`.
const port = Number(process.env.APPGOV_HOST_PORT ?? 8090);
// Loopback unless told otherwise: the Host has no authentication and takes the acting subject from the request body.
const bind = process.env.APPGOV_HOST_BIND || "127.0.0.1";
// Where the person's machine reaches this Host. Recorded in every app directory so the CLI copies find it.
const hostUrl = hostUrlFromEnv(process.env, bind, port);
const log = (line: string) => console.log(`[host] ${line}`);
const host = hostFromEnv(process.env, log, { hostUrl });
// The owner page's writes need this token. It is kept in the Host's own state directory (mode 0600), never in an
// app directory, so the owner link printed below keeps working after a restart. Delete the file to retire it.
const ownerToken = ownerTokenIn(hostStateDir(process.env), log);
const pictures = picturesFromEnv(process.env, host, log);
// Where the apps folder is on the person's computer: the container sees it as /apps. Compose passes the path it mounted.
const appsFolder = process.env.APPGOV_APPS_HOST_DIR?.trim() || undefined;
const server = createHostServer(host, { bind, ownerToken, pictures, ...(appsFolder ? { appsFolder } : {}) });
server.listen(port, bind, () => {
  const { address, port: bound } = server.address() as AddressInfo;
  host.announce();
  pictures.start();
  console.log(`[host] listening on ${address.includes(":") ? `[${address}]` : address}:${bound}, reached at ${hostUrl}; apps: ${host.list().join(", ") || "none yet"}`);
  console.log(`[host] pictures of apps: ${pictures.enabled ? `taken through ${process.env.APPGOV_SCREENSHOT_CDP}` : "off (no APPGOV_SCREENSHOT_CDP); the page shows placeholders"}`);
  console.log(`[host] your apps: ${hostUrl}/`);
  console.log(`[host] owner link (open it yourself; it lets that browser approve, deny and undo; delete ${hostStateDir(process.env)}/owner-token to retire it): ${ownerLink(hostUrl, ownerToken)}`);
  console.log(`[host] next: open the owner link above in your browser. Then open Claude Code or Codex in ${appsFolder ?? "the apps folder (local/apps)"} and ask it for an app; the page shows the steps.`);
});
