# agent-app-governance: the Cloudflare edition

[中文版](./README.zh-CN.md) · [Back to the overview](../README.md)

This edition runs the Host on Cloudflare and publishes apps to a PneumaSpace deployment on Cloudflare. Your coding agent changes an app in a working copy on any machine and submits the change; the Host checks it, has it approved by a rule or by you, publishes it, and writes it into the app's history. The Host is the same code as in the local edition, running in a Cloudflare Container behind a Worker.

## How it differs from the local edition

- **The record is at the centre.** Each app's folder (its source, every version and the history in `.pneuma-framework/`, the Host's state in `.appgov/`) is one object in an R2 bucket. Every operation loads it, runs, and saves it back only if nobody else changed it meanwhile. The container's disk is a cache: it can disappear between two operations and nothing is lost. What your agent edits is a working copy; the CLI sends it with `submit` and brings it in line with the centre after every operation that changes the app.
- **The owner signs in.** The installer generates an owner key and writes it once to a file on your machine. Signing in with it gives a session. You create agent tokens for your agents. An agent token can create apps, submit, read status and history, fetch a working copy, undo, and discard. It cannot approve or deny a change, confirm going back past a one-way change, or create tokens. These refusals happen in the Worker, not in the CLI.
- **No owner page.** There is no apps page, no screenshots, and no data snapshots. You decide in your terminal.

## Before you start

- **A Cloudflare account on Workers Paid**, with Containers available, and Wrangler logged in to it (`npx wrangler login` in `cloudflare/`). The account needs a workers.dev subdomain; the Host is served there, with no custom domain.
- **A PneumaSpace deployment on Cloudflare** (PneumaSpace's `cf/` edition), its origin, and its owner credentials file. The installer signs in as that owner once, to create a token for the Host. It does not change the deployment's Worker, schema, secrets or quotas.
- **Docker**, running, to build the Host's image for linux/amd64. On an arm64 Mac the build runs under emulation; the image is only started on Cloudflare.
- **Node.js 20 or newer** for the installer and the CLI. The CLI alone runs on Node 18.
- **Internet access.** The image fetches pneuma-framework from GitHub at the commit `local/compose.yaml` pins, and Bun from npm.

## Install

From a clone of this repository:

```sh
node cloudflare/scripts/install.mjs https://space.example.com \
  --space-owner ~/.pneuma-space/hosts/space.example.com/owner.json \
  --prefix appgov-host
```

It checks Node, Docker, the Wrangler login and the PneumaSpace sign-in before it changes anything. Then it creates the R2 bucket `<prefix>-folders` (location hint `wnam`), creates a PneumaSpace token with the scopes `read`, `publish`, `invoke`, `manage` and `remove`, generates the owner key, and deploys the Worker `<prefix>` with its container. It ends by printing the Host's address and where the owner credentials file is. Run it again after a change to this repository, or when something failed: it reuses the bucket, the token, the owner key and the container secret it made before.

Set `DOCKER_CONTEXT` first if your Docker runs under another context (for colima: `DOCKER_CONTEXT=colima`).

After a rerun deploys a new build, an app whose Durable Object is still active keeps the previous build until it goes idle; to move it now, run `node cloudflare/bin/appgov.mjs container <app> stop` as the owner, which stops the app's container and restarts its Durable Object, so the next command starts the Host from the new build (`container <app>` shows the image and Worker version in use). An app still on a build from before 2026-11-25 does not have this restart and moves only once it has been idle for a few minutes.

## Sign in and give your agent a token

```sh
node cloudflare/bin/appgov.mjs --host https://appgov-host.<subdomain>.workers.dev login
node cloudflare/bin/appgov.mjs --host https://appgov-host.<subdomain>.workers.dev token create --label laptop --write ~/apps
```

`login` reads the owner credentials file and keeps the session (12 hours) next to it. `token create --write ~/apps` writes the centre's address and a new agent token to `~/apps/.appgov/centre.json` (mode 0600) and never prints the token. Beside it, it writes the CLI this centre was deployed with, at `~/apps/.appgov/appgov.mjs`, and an `AGENTS.md` (read by Claude Code through a `CLAUDE.md`) that tells an agent started in `~/apps` what the directory is, how to list, create and fetch apps, and that `centre.json` is a credential it must not print, copy or commit. Text you keep in that `AGENTS.md` outside the block it writes stays. Your agent works in `~/apps`. `token list` and `token revoke <id>` manage the tokens.

The CLI and the centre check that they speak the same API level. A CLI at another level stops and says so; `node .appgov/appgov.mjs update` replaces it with the centre's own.

## Create an app

In `~/apps`:

```sh
node .appgov/appgov.mjs create todo
```

The Host copies this edition's app template (PneumaSpace's Cloudflare starter, contract `pneuma-space.cf/1`, with `identity.required` declared), adds the instructions for your agent, runs the app's tests, starts it once as a preview, and publishes it as `v1`, as an app managed by `appgov` on PneumaSpace. The working copy lands in `~/apps/todo/`, with its own copy of the CLI in `.appgov/appgov.mjs` and the address and token in `.appgov/centre.json`. The app answers at `https://<PneumaSpace origin>/apps/todo/` to anyone signed in to that PneumaSpace.

## Hand the app to your agent

Open `~/apps/todo/` with Claude Code, Codex or another agent and ask for a change. The app's `AGENTS.md` (read by Claude Code through `CLAUDE.md`) opens with the rules: look at `status` and `history`, edit, add a test under `tests/`, run `npm test`, and submit with `node .appgov/appgov.mjs submit "<what you asked for>"`.

To continue on another machine, fetch a working copy there:

```sh
APPGOV_HOST=https://appgov-host.<subdomain>.workers.dev APPGOV_TOKEN=<an agent token> \
  node appgov.mjs fetch todo
```

A working copy that is behind the centre (someone released a version since) is refused on `submit`; `fetch` brings it up to date and refuses while there are edits it would overwrite.

`.appgov/centre.json` holds the agent token. It is never part of a version and never sent with the files; the template's `.gitignore` keeps it out of git. Keep it out of anything you share.

## Decide

The Host runs in `personal` mode. A change has to pass the app's tests (run in the Host's container; `submit` and `history` say how many of them are the app's own, and warn when a change to `app/` ran none of them) and start in a preview, which is an ephemeral app on PneumaSpace that is discarded afterwards. A standing rule lets ordinary changes go live. With this edition's preset (`policy/personal.json`), a change waits for you when the app stops declaring `identity.required`, or when new SQL drops or renames a table or column, drops an index, empties a table, or deletes every row.

When `submit` answers `needs_approval <id>`, the agent stops and shows you what it printed, including the preview's address. Signed in as the owner, in the app's working copy:

```sh
node .appgov/appgov.mjs approve <id>
node .appgov/appgov.mjs deny <id> "why"
```

An agent token that tries this is refused by the Worker.

## Go back

```sh
node .appgov/appgov.mjs undo "why"          # back one version
node .appgov/appgov.mjs undo --to v2 "why"  # straight back to an earlier version
```

Undo puts back an earlier version's code. When PneumaSpace still has a release with exactly those files, the Host uses its typed action `rollback`; otherwise it uploads them again. Stored data stays as it is. Going back past a one-way change needs the owner: signed in, `undo --accept-one-way "why"`.

## Where things live

| What | Where |
| --- | --- |
| Each app's source, every version, the history, changes that wait | One tar object per app in the R2 bucket `<prefix>-folders` (`folders/<app>.tar`), plus a short summary for `list` (`summaries/<app>.json`) |
| A working copy | Wherever you created or fetched it; the CLI mirrors the centre's `.pneuma-framework/` into it |
| The owner's sessions and the agent tokens, hashed | A Durable Object of the Worker |
| The owner key, the Worker's secrets, the generated Wrangler configuration | `~/.appgov/hosts/<prefix>/` on the machine that ran the installer (mode 0700) |
| The owner session the CLI uses | `~/.appgov/hosts/<prefix>/session.json` |
| Each app's stored data and its releases | PneumaSpace |

## Limits

- **The threat model is an agent that makes mistakes, not one that attacks.** The app's tests run in the Host's container as a second unix user that cannot read the Host's files or its environment (the PneumaSpace token and the secret the Worker sends). They share the kernel, the network (with Internet access) and the disk. There is no second sandbox.
- Left out: the owner page, screenshots, the data snapshot practice, starting Claude Code or Codex from the Host (the `drive` lane), and `record` and `review-all` modes. Only `personal` mode has been run.
- New apps only. Nothing imports an existing app or its data.
- Undo restores code; stored data is never put back.
- PneumaSpace tokens cannot purge an app. When the Host takes an app's address down, the app is removed and its name stays taken until the PneumaSpace owner purges it in the console.
- One container per app, started on demand. A submit holds the connection open for the whole check, about 30 seconds in the runs below, about two thirds of it PneumaSpace releasing the preview and then the release (see the table below).
- The default rules find destructive SQL by matching text, as in the local edition.

## What has been run

On 2026-11-25, from macOS with colima, against a PneumaSpace deployment on Cloudflare with default quotas: the install (and two reruns), owner sign-in, an agent token, `create`, an ordinary change released by the standing rule, a change that dropped `identity.required` and waited for the owner (the agent token's approve refused with 403, the owner's approve released it), `undo`, `fetch` into an empty directory with the token and a submit from there, a refused submit from a stale working copy, submits after the container was stopped, and a test that failed on purpose to show what the tests user can read (it could not read `/data`, the Host's home directory or the Host's environment, and had no `APPGOV_` variables). The offline tests (`npm run setup`, `npm run typecheck`, `bun test` in `cloudflare/`) cover the runtime adapter against a fake plane, the record round trip with a conflicting write, the Worker's rules for the owner and agent tokens, and the whole loop with the CLI on one machine.

Where a submit's time goes, measured with `--timing` (which prints the steps each answer carries in `timing`) on an ordinary change, one cold and two warm submits each, before and after the savings described below. Seconds; the cold submit includes starting the container and loading the record.

| Step | Before: cold, warm, warm | After: cold, warm, warm |
| --- | --- | --- |
| The whole submit, at the CLI | 41.5, 42.8, 40.5 | 31.9, 30.0, 30.3 |
| Start the container, load the record from R2 | 1.8, 0, 0 | 1.2, 0, 0 |
| Look up the app on PneumaSpace | 1.3, 0.9, 0.9 | 1.0, 0.5, 0.5 |
| Tests: `npm ci --ignore-scripts` | 1.2, 1.6, 1.5 | 1.2, 0.0, 0.0 |
| Tests: `npm test` | 0.8, 1.5, 1.5 | 0.8, 1.6, 1.6 |
| Preview: look up, create, upload ticket, upload | 4.3, 3.6, 3.5 | 2.6, 2.7, 2.7 |
| Preview: PneumaSpace releases it | 9.5, 12.3, 9.2 | 8.9, 8.3, 9.2 |
| Wait until the preview answers (and put it to sleep) | 3.9, 4.1, 4.3 | 0.6, 0.7, 0.7 |
| Read the preview's state | 0.9, 0.9, 0.9 | 0.6, 0.5, 0.5 |
| Release: look up, upload ticket, upload | 2.3, 2.3, 2.7 | 1.8, 1.8, 1.7 |
| Release: PneumaSpace releases it | 10.2, 10.3, 10.1 | 10.9, 11.4, 10.9 |
| Wait until the release answers | 1.5, 1.5, 1.4 | 0.6, 0.6, 0.7 |
| Discard the preview | 2.2, 2.1, 2.1 | 3.7, 3.6, 3.5, while the release goes out |
| Save the record to R2 | 0.5, 0.5, 0.5 | 0.3, 0.3, 0.3 |
| The network, the Worker and the Durable Object | 0.9, 0.9, 1.5 | 1.2, 1.4, 1.3 |

The savings taken change nothing that is checked: both probe requests go out at the same time instead of one after the other; putting the preview to sleep after its probe is no longer waited for; the preview is discarded while the release goes out (the release never draws on the preview's upload on this plane, and the submit still answers only once the discard is over); a lookup reads only the app's detail once its id is known, and nothing is read back right after a create; and `npm ci --ignore-scripts` reuses the install an earlier run made from the same `package.json`, lockfile and `.npmrc` in the same container, kept as it was before any test ran and out of the tests user's reach. Not taken: anything that skips or shortens a check (the tests, either probe, the preview), releasing before the preview answers or at the same time as it, running the tests and the preview at the same time (a change that fails its tests would then reach PneumaSpace as a preview), and uploading the release before the decision to release (what goes out has to be the copy checked against the sealed draft right before it is recorded). The two PneumaSpace releases, about 20 s of the 30, are the platform's own work, which this edition does not change. An earlier run of the after set gave 30.5, 28.1 and 29.3 s. `create` took 44 s before and 32 to 38 s after, `undo` 9 s, `fetch` 1 s.

Not run: a real coding agent session against this edition, several people, a Linux machine as the installer's host, waiting more than an hour for a preview to end, and anything beyond PneumaSpace's default quotas (5 apps, 3 ephemeral, 2 awake).
