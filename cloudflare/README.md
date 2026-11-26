# agent-app-governance: the Cloudflare edition

[中文版](./README.zh-CN.md) · [Back to the overview](../README.md)

This edition runs the Host on Cloudflare and publishes apps to a PneumaSpace deployment on Cloudflare. Your coding agent changes an app in a working copy on any machine and submits the change; the Host checks it, has it approved by a rule or by you, publishes it, and writes it into the app's history. The Host is the same code as in the local edition, running in a Cloudflare Container behind a Worker.

## How it differs from the local edition

- **The record is at the centre.** Each app's folder (its source, every version and the history in `.pneuma-framework/`, the Host's state in `.appgov/`) is one object in an R2 bucket. Every operation loads it, runs, and saves it back only if nobody else changed it meanwhile. The container's disk is a cache: it can disappear between two operations and nothing is lost. What your agent edits is a working copy; the CLI sends it with `submit` and brings it in line with the centre after every operation that changes the app.
- **The owner signs in.** The installer generates an owner key and writes it once to a file on your machine. Signing in with it gives a session. You create agent tokens for your agents. An agent token can create apps, submit, read status and history, fetch a working copy, undo, and discard. It cannot approve or deny a change, confirm going back past a one-way change, or create tokens. These refusals happen in the Worker, not in the CLI.
- **The apps page asks you to sign in.** The Worker serves the local edition's apps page at its own address. It shows nothing until you sign in with the owner key, and the session lasts 12 hours. It takes no screenshots, and there are no data snapshots.

## Before you start

- **A Cloudflare account on Workers Paid**, with Containers available, and Wrangler logged in to it (`npx wrangler login` in `cloudflare/`). The account needs a workers.dev subdomain; the Host is served there, with no custom domain.
- **A PneumaSpace deployment on Cloudflare** (PneumaSpace's `cf/` edition), its origin, and its owner credentials file. The installer signs in as that owner once, to create a token for the Host. It does not change the deployment's Worker, schema, secrets or quotas.
- **Docker**, running, to build the Host's image for linux/amd64. On an arm64 Mac the build runs under emulation; the image is only started on Cloudflare.
- **Node.js 20 or newer** for the installer and the CLI. The CLI alone runs on Node 18.
- **Bun** ([bun.sh](https://bun.sh)), which builds the apps page from `local/web/`. When its tools are missing, the installer runs `local/scripts/setup.sh` for them.
- **Internet access.** The image fetches pneuma-framework from GitHub at the commit `local/compose.yaml` pins, and Bun from npm.

## Install

From a clone of this repository:

```sh
node cloudflare/scripts/install.mjs https://space.example.com \
  --space-owner ~/.pneuma-space/hosts/space.example.com/owner.json \
  --prefix appgov-host
```

It checks Node, Docker, the Wrangler login and the PneumaSpace sign-in, and builds the apps page, before it changes anything. Then it creates the R2 bucket `<prefix>-folders` (location hint `wnam`), creates a PneumaSpace token with the scopes `read`, `publish`, `invoke`, `manage` and `remove`, generates the owner key, and deploys the Worker `<prefix>` with its container and the apps page. It then reads every app once, so each has its stored view (see below) before anyone opens it, and ends by printing the Host's address and where the owner credentials file is. Run it again after a change to this repository, or when something failed: it reuses the bucket, the token, the owner key and the container secret it made before.

Set `DOCKER_CONTEXT` first if your Docker runs under another context (for colima: `DOCKER_CONTEXT=colima`).

After a rerun deploys a new build, an app whose Durable Object is still active keeps the previous build until it goes idle; to move it now, run `node cloudflare/bin/appgov.mjs container <app> stop` as the owner, which stops the app's container and restarts its Durable Object, so the next command starts the Host from the new build (`container <app>` shows the image and Worker version in use). An app still on a build from before 2026-11-25 does not have this restart and moves only once it has been idle for a few minutes.

## Sign in and give your agent a token

```sh
node cloudflare/bin/appgov.mjs --host https://appgov-host.<subdomain>.workers.dev login
node cloudflare/bin/appgov.mjs --host https://appgov-host.<subdomain>.workers.dev token create --label laptop --write ~/apps
```

`login` reads the owner credentials file and keeps the session (12 hours) next to it. `token create --write ~/apps` writes the centre's address and a new agent token to `~/apps/.appgov/centre.json` (mode 0600) and never prints the token. Beside it, it writes the CLI this centre was deployed with, at `~/apps/.appgov/appgov.mjs`, and an `AGENTS.md` (read by Claude Code through a `CLAUDE.md`) that tells an agent started in `~/apps` what the directory is, how to list, create and fetch apps, and that `centre.json` is a credential it must not print, copy or commit. Text you keep in that `AGENTS.md` outside the block it writes stays. Your agent works in `~/apps`. `token list` and `token revoke <id>` manage the tokens.

The history names who acted from the credential the centre authenticated, not from the environment the CLI ran in: an operation with the owner's session is the owner's, and one with an agent token is recorded as the agent the CLI detected (or `unknown`), with the token's label. A decision names the owner who made it and the agent whose change it was.

The CLI and the centre check that they speak the same API level. A CLI at another level stops and says so; `node .appgov/appgov.mjs update` replaces it with the centre's own.

## Open the apps page

Open `https://appgov-host.<subdomain>.workers.dev/` and sign in with the key in the owner credentials file (`owner.json`, the value of `key`). The page lists your apps and the changes that wait for you; that list comes from the summaries in R2 and starts nothing. Opening one app, a change that waits or the plan for going back reads that app's stored view in R2, which its Durable Object writes after every operation that changed the app: no container starts for it, whether the app's container sleeps or a new build was just deployed. Deciding, going back and showing a preview again go through the app's container; opening a waiting change or a plan starts it meanwhile, so the decision does not also wait for it to start. A preview past its end shows as ended. One discarded by hand on PneumaSpace still shows until you decide, and the decision then says it is gone. The page is in English or Chinese, following your browser's language.

What you decide or undo there is recorded as yours, as from the CLI (`by user:owner (owner session) [owner]`), and marked as made on the page. Wrong keys count against the same limit as `login`: 20 in ten minutes from one address. An agent token or a CLI session does not open the page, and a write from another site is refused. The page's session lasts 12 hours; "You can decide here", under a page's title, opens a card with "Sign out", which ends it. The app and its previews open on PneumaSpace, where you sign in separately; the page says so beside those links.

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

A working copy that is behind the centre (someone released a version since) is refused on `submit`; `fetch` brings it up to date and refuses while there are edits it would overwrite. `status` there says the copy is behind, which versions the centre released or went back past since, and lists as edits only what differs from the version the copy holds. `status` and `history` read the app's stored view, as the apps page does, so they start no container.

`.appgov/centre.json` holds the agent token. It is never part of a version and never sent with the files; the template's `.gitignore` keeps it out of git. Keep it out of anything you share.

## Decide

The Host runs in `personal` mode. A change has to pass the app's tests (run in the Host's container; `submit` and `history` say how many of them are the app's own, and warn when a change to `app/` ran none of them) and start in a preview, which is an ephemeral app on PneumaSpace that is discarded afterwards. A standing rule lets ordinary changes go live. With this edition's preset (`policy/personal.json`), a change waits for you when the app stops declaring `identity.required`, when it stops declaring a capability that keeps stored data (`db`, `kv`, `files` or `object`; PneumaSpace keeps the data, but the app no longer reaches it, so this is also one-way), or when new SQL drops or renames a table or column, drops an index, empties a table, or deletes every row.

The rules read only SQL text and the manifest, so a change that deletes or rewrites what the app keeps in `kv`, `files` or objects looks to them like an ordinary code change. For that, the agent declares it: `submit --one-way "<what is lost>"`, which the app's `AGENTS.md` tells it to use whenever a change deletes or rewrites stored data. The preset sets the least a change needs and a declaration can only raise it: a declared change waits for you whatever its risks, you read the agent's words in a line of their own marked as its statement, not a finding of the rules, and once released it is recorded one-way.

When `submit` answers `needs_approval <id>`, the agent stops and shows you what it printed, including the preview's address. On the apps page the change is under "Waiting for you": what it does in the agent's words, which agent sent it with which token, how many of the app's own tests ran (or that none did), why it waits, whether going back could undo it and, when not, what the rules found and what the agent says is lost, each marked for what it is, and its preview. "Let it go live" and "Not this time" decide; a one-way change asks you to tick that you accept it first. A decision takes about as long as a submit, often 15 to 30 seconds; the page says it is working and sends it once. A change made on a version the app has since left cannot go live, and the page says so; you can still say no.

In a terminal, signed in as the owner, in the app's working copy:

```sh
node .appgov/appgov.mjs approve <id>
node .appgov/appgov.mjs deny <id> "why"
```

An agent token that tries this is refused by the Worker. Each command shows the change, asks you to type its word (`approve` or `deny`), and without an interactive terminal refuses before anything is sent, signed in or not.

Who a command acts as, in a working copy or anywhere else:

- **As you, the owner:** `approve`, `deny`, `undo --accept-one-way`, `token create`, `token revoke`, `container stop`, and `create`, `submit`, `discard`, `undo` or `preview` given `--owner`. They send your session, never the agent token, and only after you type the command's name in an interactive terminal. The history records them as yours (`by owner (owner session) [owner]`). `login` needs a terminal too.
- **As the agent:** every other command that changes something. It goes with the agent token in `.appgov/centre.json` (or `APPGOV_TOKEN`) and is recorded as the agent's, with the token's label, also when you are the one who runs it. Without a token it is refused; it never falls back to your session.
- **Reading** (`status`, `history`, `list`, `fetch`) changes nothing and is not recorded. It uses the agent token, or your session when there is no token.

Coding agents run commands without an interactive terminal, so an honest agent on your machine does not finish your part itself, although it runs as you and could read your session file. That is the local edition's check, and it is not a lock; see Limits.

## Go back

On an app's page, every version the current one was built on has "Go back to this". The page shows which changes that undoes and what happens to stored data, and asks you to confirm when it goes back past a one-way change, naming any of them its submitter declared one-way, with its words. Then it says once what stays in stored data, and those words again. In a terminal:

```sh
node .appgov/appgov.mjs undo --owner "why"          # back one version, as you
node .appgov/appgov.mjs undo --owner --to v2 "why"  # straight back to an earlier version
```

Each asks you to type `undo`. Without `--owner`, an undo in a working copy goes with the agent token and is recorded as the agent's: that is how an agent goes back.

Undo puts back an earlier version's code. When PneumaSpace still has a release with exactly those files, the Host uses its typed action `rollback`; otherwise it uploads them again. Stored data stays as it is. When the versions it went back past declared other storage in `pneuma-space.json` or ran SQL the earlier version does not, `undo` says that the data they wrote is still stored and the earlier code may not show it; when one of them was declared one-way by its submitter, `undo` prints the submitter's words too. Going back past a one-way change needs the owner: signed in, in a terminal, `undo --accept-one-way "why"`, which asks you to type `undo` and, once it has shown what the crossing means, `accept`.

## Where things live

| What | Where |
| --- | --- |
| Each app's source, every version, the history, changes that wait | One tar object per app in the R2 bucket `<prefix>-folders` (`folders/<app>.tar`), plus a short summary for `list` (`summaries/<app>.json`) |
| What reading one app needs: its status, its history and the plans for going back | The app's stored view in the same bucket (`views/<app>.json`), written with the folder. It names the folder's etag and its own shape; a reader that finds another etag or another shape has the container compute it again once, and it is stored for the next |
| A working copy | Wherever you created or fetched it; the CLI mirrors the centre's `.pneuma-framework/` into it |
| The owner's sessions (the CLI's and the apps page's, each kind under its own prefix) and the agent tokens, hashed | A Durable Object of the Worker |
| The apps page's files | The Worker's static assets, built by the installer from `local/web/` |
| The owner key, the Worker's secrets, the generated Wrangler configuration | `~/.appgov/hosts/<prefix>/` on the machine that ran the installer (mode 0700) |
| The owner session the CLI uses | `~/.appgov/hosts/<prefix>/session.json` |
| Each app's stored data and its releases | PneumaSpace |

## Limits

- **The threat model is an agent that makes mistakes, not one that attacks.** The app's tests run in the Host's container as a second unix user that cannot read the Host's files or its environment (the PneumaSpace token and the secret the Worker sends). They share the kernel, the network (with Internet access) and the disk. There is no second sandbox.
- Left out: screenshots, the data snapshot practice, starting Claude Code or Codex from the Host (the `drive` lane), and `record` and `review-all` modes. Only `personal` mode has been run.
- New apps only. Nothing imports an existing app or its data.
- Undo restores code; stored data is never put back.
- **An agent cannot open the live app or its preview.** Both answer only to people signed in to PneumaSpace, and an agent token is the centre's, not PneumaSpace's: the agent gets 401. So an agent cannot check its own release. The Host's probes only fetch the home page and one path that starts Node, so a change that breaks a data route can still pass and go live. You see it working only by opening the app yourself.
- **A preview starts with empty storage.** It is a separate app on PneumaSpace, without the app's data. When a change that drops or rewrites stored data waits for you, the preview does not show it applied to that data; you decide from the disclosure, not from seeing which stored values would go.
- PneumaSpace tokens cannot purge an app. When the Host takes an app's address down, the app is removed and its name stays taken until the PneumaSpace owner purges it in the console.
- One container per app, started on demand for what changes the app; reading it needs none. A submit holds the connection open for the whole check, about 30 seconds in the runs below, about two thirds of it PneumaSpace releasing the preview and then the release (see the table below).
- The default rules find destructive SQL by matching text, as in the local edition.
- **On your machine, your session is a bearer credential.** An agent there runs as your OS user, so it can read `~/.appgov/hosts/<prefix>/session.json` and the owner key beside it. The CLI does not act as you without an interactive terminal and a typed word, and the agent instructions tell agents never to read those files or run those commands. Nothing stops a program that sends your session to the Worker itself, or runs the CLI in a terminal it makes. Against an agent that attacks, keep the owner key and sessions where agents do not run: another OS account or another machine.
- **For storage other than SQL, the Host relies on the agent's declaration.** The rules read SQL text and the manifest only. A change that deletes or rewrites `kv` entries, files or objects is released by the standing rule unless the agent submits it with `--one-way`.

## What has been run

On 2026-11-25, from macOS with colima, against a PneumaSpace deployment on Cloudflare with default quotas: the install (and two reruns), owner sign-in, an agent token, `create`, an ordinary change released by the standing rule, a change that dropped `identity.required` and waited for the owner (the agent token's approve refused with 403, the owner's approve released it), `undo`, `fetch` into an empty directory with the token and a submit from there, a refused submit from a stale working copy, submits after the container was stopped, and a test that failed on purpose to show what the tests user can read (it could not read `/data`, the Host's home directory or the Host's environment, and had no `APPGOV_` variables). The offline tests (`npm run setup`, `npm run typecheck`, `bun test` in `cloudflare/`) cover the runtime adapter against a fake plane, the record round trip with a conflicting write, the Worker's rules for the owner and agent tokens, the apps page's sign-in and its rules against other sites, the page's views on the edition's answers, and the whole loop with the CLI on one machine. On 2026-11-26 the apps page ran on the deployment, in headless Chrome, with a test app of its own beside the owner's two: the sign-in view on every path without a session, a wrong key refused, the cookie's attributes, an agent token, a CLI session and writes from another site refused, the list read from the summaries while the test app's container stayed stopped, an ordinary change released by the rule, a change dropping `identity.required` said no to on the page, a change declared one-way let through on the page (one request however often the button was pressed), going back past it on the page, and signing out. As the owner felt it: the list 0.4 to 0.8 s; an app's page about 1.3 s awake, 3.7 s after its container slept (14 s the first time after the deploy); a waiting change 2 s; saying no 3.6 s; letting a change go live 16 to 18 s; going back 11 s. Those reads still went through the app's container; since then they come from stored views, which have been run offline only.

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
