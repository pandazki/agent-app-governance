# agent-app-governance: the Cloudflare edition

[中文版](./README.zh-CN.md) · [Back to the overview](../README.md)

This edition runs the Host on Cloudflare and publishes apps to a PneumaSpace deployment on Cloudflare. Your coding agent changes an app in a working copy on any machine and submits the change; the Host checks it, has it approved by a rule or by you, publishes it, and writes it into the app's history. The Host is the same code as in the local edition, running in a Cloudflare Container behind a Worker.

## How it differs from the local edition

- **The record is at the centre.** Each app's folder (its source, every version and the history in `.pneuma-framework/`, the Host's state in `.appgov/`) is one object in an R2 bucket. Every operation loads it, runs, and saves it back only if nobody else changed it meanwhile. The container's disk is a cache: it can disappear between two operations and nothing is lost. What your agent edits is a working copy; the CLI sends it with `submit` and brings it in line with the centre after every operation that changes the app.
- **The owner signs in.** The installer generates an owner key and writes it once to a file on your machine. Signing in with it gives a session. You create tokens for your agents. A token can create apps, submit, read status and history, fetch a working copy, undo, and discard. It cannot approve or deny a change, confirm going back past a one-way change, take an app down, bring it back, publish it again or clear it, or create tokens. These refusals happen in the Worker, not in the CLI.
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

To serve the Host on your own domain instead of its workers.dev address, add `--domain host.example.com`. The hostname's zone must be in the same Cloudflare account, and a hostname another Worker has as a custom domain is refused, never taken over (so is one with DNS records of its own). The installer attaches the hostname to the Worker as a custom domain (before deploying, when the Worker exists, so the domain answers before anything sends you there), waits until it answers over HTTPS (it asks the zone's own nameservers until they have the record before it looks the hostname up through this machine's resolver, which would keep an early "no such host" for up to 30 minutes; if that happens anyway, it stops before deploying and says so, and a later rerun goes on), and from then on the domain is the Host's address everywhere it gives one: the installer's output, the owner credentials file and the CLI's session file, the address `token create` and `create` and `fetch` write to `centre.json`, the starter instructions, the links on the apps page, the origin the page's writes must come from, and the manager address apps get when they are created on PneumaSpace. The workers.dev address keeps answering the API, so a working copy that holds it keeps working, and every answer names the Host's address: the CLI there says once that the Host has moved, and `node .appgov/appgov.mjs update` (run twice with a CLI from before this change: the first run fetches the new CLI) moves the nearest `centre.json` to the domain, keeping its token. The apps page at the workers.dev address sends you to the domain; its session cookie belongs to one address, so you sign in again there. A rerun without `--domain` keeps the domain. To move to another domain or back to workers.dev, remove the hostname from the Worker in the Cloudflare dashboard (Workers, the Worker, Settings, Domains & Routes), delete `"domain"` from `install.json` in `~/.appgov/hosts/<prefix>/`, and run the installer again (with the new `--domain`, or without); working copies that hold the old domain then need `update` or a new `centre.json`. On PneumaSpace, an app names the manager address of its last release through the Host: one created before takes the new address at its next release, and until then names the old one.

After a rerun deploys a new build, an app whose Durable Object is still active keeps the previous build until it goes idle; to move it now, run `node cloudflare/bin/appgov.mjs container <app> stop` as the owner, which stops the app's container and restarts its Durable Object, so the next command starts the Host from the new build (`container <app>` shows the image and Worker version in use). An app still on a build from before 2026-11-25 does not have this restart and moves only once it has been idle for a few minutes.

## Open the apps page and connect your assistant

Open the Host's address, which the installer printed last (`https://appgov-host.<subdomain>.workers.dev/`, or your `--domain`), and sign in with the key in the owner credentials file (`owner.json`, the value of `key`). While there are no apps, the page shows the two steps to a first one.

1. **Connect my AI assistant.** Name the connection, for example after the computer, and press "Get a code". The page shows a sentence to paste to Claude Code or Codex, opened in an empty folder for your apps, such as `~/apps`:

   > Connect this folder to my apps Host. This command gets the Host's own tool from my Host and trades a one-time code for a token, saved in .appgov/ (never show it to anyone). It needs network access, and it worked only if it prints a line starting with "connected". Then read AGENTS.md. Run it here: `curl -fsSo .appgov-connect.cjs https://appgov-host.<subdomain>.workers.dev/connect && node .appgov-connect.cjs K7QM-4XPD-2R9T`

   `GET /connect` answers a short script that holds this Host's own CLI and its address, nothing secret; when the download fails, the command stops with curl's error. The script removes itself, writes the CLI to `.appgov/appgov.mjs` and runs `connect <code>` with it, which trades the code at the Host for a token and writes it to `.appgov/centre.json` (mode 0600, never printed), then writes the `AGENTS.md` and `CLAUDE.md` that `token create --write` writes (below). Nothing else is written, nothing is fetched from anywhere but your Host, and when connecting fails the script puts back what it replaced and takes away what it wrote. The page waits until the code is used, then shows the connection. Codex blocks the network by default: start it with `codex -c sandbox_workspace_write.network_access=true`, or allow the command when it asks.

   The code is 12 letters and digits. It works once, for ten minutes, and closing the panel or the tab makes it useless at once; five codes at most wait at the same time. Only its SHA-256 is kept. Wrong codes are counted per address (an IPv6 address per /64): after 20 in ten minutes from one, it is refused until the ten minutes are over. There is no count shared by every address, which anyone could use up to stop your own code. Checking the count, taking the code and making the token are one step. The token it gives is an ordinary one, named as you named the connection and valid for 90 days, with the same rights as any other and no more. A token cannot make a code: codes come only from the page, in your session.

2. **Ask it for your first app.** The page then shows a sentence to say, or say what you want in your own words. The agent creates the app with `node .appgov/appgov.mjs create <name>` and makes it there. On PneumaSpace's default quotas the deployment holds 5 apps, 3 ephemeral apps (each preview is one) and 2 apps awake at once.

Every connection is listed under "AI assistants" at the bottom of the home page, with the agent that connected, when, and when it was last used (to the hour), tokens made in a terminal included. "Revoke" shows what it does and asks you to confirm; the token then stops working at once, and the folder keeps its files. "Connect another" makes a new code.

## Or give your agent a token in a terminal

```sh
node cloudflare/bin/appgov.mjs --host https://appgov-host.<subdomain>.workers.dev login
node cloudflare/bin/appgov.mjs --host https://appgov-host.<subdomain>.workers.dev token create --label laptop --write ~/apps
```

(With `--domain`, use `--host https://host.example.com`: the address the installer printed.)

`login` reads the owner credentials file and keeps the session (12 hours) next to it. `token create --write ~/apps` writes the centre's address and a new token to `~/apps/.appgov/centre.json` (mode 0600) and never prints the token. Beside it, it writes the CLI this centre was deployed with, at `~/apps/.appgov/appgov.mjs`, and an `AGENTS.md` (read by Claude Code through a `CLAUDE.md`) that tells an agent started in `~/apps` what the directory is, how to list, create and fetch apps, and that `centre.json` is a credential it must not print, copy or commit. Text you keep in that `AGENTS.md` outside the block it writes stays. Your agent works in `~/apps`. `token list` and `token revoke <id>` manage the tokens.

The history names who acted from the credential the centre authenticated, not from the environment the CLI ran in: an operation with the owner's session is the owner's, and one with a token is recorded as the agent the CLI detected (or `unknown`), with the token's label. A decision names the owner who made it and the agent whose change it was.

The CLI and the centre check that they speak the same API level. A CLI at another level stops and says so; `node .appgov/appgov.mjs update` replaces it with the centre's own.

## The apps page

The page lists your apps and the changes that wait for you; that list comes from the summaries in R2 and starts nothing. Opening one app, a change that waits or the plan for going back reads that app's stored view in R2, which its Durable Object writes after every operation that changed the app: no container starts for it, whether the app's container sleeps or a new build was just deployed. The stored view keeps the same size however long the app lives: it holds the app's newest 50 history entries and the plans for going back to the 8 versions nearest the current one, the ones the app's page offers before "Show earlier". Going back further, the container works the plan out when you open it (the page shows "Opening…" meanwhile), and it is kept for the next time until the app changes. An app with more history than that links to its whole history, read from its folder. Deciding, going back and showing a preview again go through the app's container; opening a waiting change or a plan starts it meanwhile, so the decision does not also wait for it to start. Each view, and the API's `status` and `history`, says in its `Server-Timing` header how long each read took in the Worker (the summaries list and their index, the stored view, the folder's etag, the plans kept, the container when what was stored could not be used) and where the view and a plan came from. A preview past its end shows as ended. One discarded by hand on PneumaSpace still shows until you decide, and the decision then says it is gone. The page is in English or Chinese, following your browser's language.

What you decide or undo there is recorded as yours, as from the CLI (`by user:owner (owner session) [owner]`), and marked as made on the page. Wrong keys count against the same limit as `login`: 20 in ten minutes from one address. A token or a CLI session does not open the page, and a write from another site is refused. The page's session lasts 12 hours; "You can decide here", under a page's title, opens a card with "Sign out", which ends it. The app and its previews open on PneumaSpace, where you sign in separately; the page says so beside those links.

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
APPGOV_HOST=https://appgov-host.<subdomain>.workers.dev APPGOV_TOKEN=<a token> \
  node appgov.mjs fetch todo
```

A working copy that is behind the centre (someone released a version since) is refused on `submit`; `fetch` brings it up to date and refuses while there are edits it would overwrite. `status` there says the copy is behind, which versions the centre released or went back past since, and lists as edits only what differs from the version the copy holds. `status` and `history` read the app's stored view, as the apps page does, so they start no container; `history` of an app with more than 50 entries reads the whole history from the app's folder, through its container.

`.appgov/centre.json` holds the token. It is never part of a version and never sent with the files; the template's `.gitignore` keeps it out of git. Keep it out of anything you share.

## Decide

The Host runs in `personal` mode. A change has to pass the app's tests (run in the Host's container; `submit` and `history` say how many of them are the app's own, and warn when a change to `app/` ran none of them) and start in a preview, which is an ephemeral app on PneumaSpace that is discarded afterwards. A standing rule lets ordinary changes go live. With this edition's preset (`policy/personal.json`), a change waits for you when the app stops declaring `identity.required`, when it stops declaring a capability that keeps stored data (`db`, `kv`, `files` or `object`; PneumaSpace keeps the data, but the app no longer reaches it, so this is also one-way), or when new SQL drops or renames a table or column, drops an index, empties a table, or deletes every row.

In the preview, the app must also answer as expected the requests it declares in `tests/preview.json`; the Host makes them itself (see Limits).

The rules read only SQL text and the manifest, so a change that deletes or rewrites what the app keeps in `kv`, `files` or objects looks to them like an ordinary code change. For that, the agent declares it: `submit --one-way "<what is lost>"`, which the app's `AGENTS.md` tells it to use whenever a change deletes or rewrites stored data. The preset sets the least a change needs and a declaration can only raise it: a declared change waits for you whatever its risks, you read the agent's words in a line of their own marked as its statement, not a finding of the rules, and once released it is recorded one-way.

When `submit` answers `needs_approval <id>`, the agent stops and shows you what it printed, including the preview's address. On the apps page the change is under "Waiting for you": what it does in the agent's words, which agent sent it with which token, how many of the app's own tests ran (or that none did), why it waits, whether going back could undo it and, when not, what the rules found and what the agent says is lost, each marked for what it is, and its preview. "Let it go live" and "Not this time" decide; a one-way change asks you to tick that you accept it first. A decision takes about as long as a submit, often 15 to 30 seconds; the page says it is working and sends it once. A change made on a version the app has since left cannot go live, and the page says so; you can still say no.

In a terminal, signed in as the owner, in the app's working copy:

```sh
node .appgov/appgov.mjs approve <id>
node .appgov/appgov.mjs deny <id> "why"
```

With an agent's token, the Worker refuses these. Each command shows the change, asks you to type its word (`approve` or `deny`), and without an interactive terminal refuses before anything is sent, signed in or not.

Who a command acts as, in a working copy or anywhere else:

- **As you, the owner:** `approve`, `deny`, `undo --accept-one-way`, `token create`, `token revoke`, `container stop`, `take-down`, `bring-back`, `publish-again`, `clear`, and `create`, `submit`, `discard`, `undo` or `preview` given `--owner`. They send your session, never an agent's token, and only after you type the command's name in an interactive terminal. The history records them as yours (`by owner (owner session) [owner]`). `login` needs a terminal too.
- **As the agent:** every other command that changes something. It goes with the token in `.appgov/centre.json` (or `APPGOV_TOKEN`) and is recorded as the agent's, with the token's label, also when you are the one who runs it. Without a token it is refused; it never falls back to your session.
- **Reading** (`status`, `history`, `list`, `fetch`) changes nothing and is not recorded. It uses the token, or your session when there is none.

Coding agents run commands without an interactive terminal, so an honest agent on your machine does not finish your part itself, although it runs as you and could read your session file. That is the local edition's check, and it is not a lock; see Limits.

## Go back

On an app's page, every version the current one was built on has "Go back to this". The page shows which changes that undoes and what happens to stored data, and asks you to confirm when it goes back past a one-way change, naming any of them its submitter declared one-way, with its words. Then it says once what stays in stored data, and those words again. In a terminal:

```sh
node .appgov/appgov.mjs undo --owner "why"          # back one version, as you
node .appgov/appgov.mjs undo --owner --to v2 "why"  # straight back to an earlier version
```

Each asks you to type `undo`. Without `--owner`, an undo in a working copy goes with the token in `.appgov/centre.json` and is recorded as the agent's: that is how an agent goes back.

Undo puts back an earlier version's code. When PneumaSpace still has a release with exactly those files, the Host uses its typed action `rollback`; otherwise it uploads them again. Stored data stays as it is. When the versions it went back past declared other storage in `pneuma-space.json` or ran SQL the earlier version does not, `undo` says that the data they wrote is still stored and the earlier code may not show it; when one of them was declared one-way by its submitter, `undo` prints the submitter's words too. Going back past a one-way change needs the owner: signed in, in a terminal, `undo --accept-one-way "why"`, which asks you to type `undo` and, once it has shown what the crossing means, `accept`.

## Take an app down, bring it back, or clear it

The Host knows whether each app is on PneumaSpace. `status`, `list`, the list of apps, an app's page and the going-back page say first when it is not: you took it down, it was taken down on PneumaSpace but not through the Host, PneumaSpace no longer has it, or PneumaSpace did not answer. While an app is taken down or missing, submitting, approving a waiting change and going back are refused, and nothing creates the app again on its own.

These are yours: signed in, in a terminal, each asks you to type its name (for `clear`, the app's name). In `~/apps`, name the app; any words after the name are your reason, and the history keeps them.

```sh
node .appgov/appgov.mjs take-down todo "why"   # stop serving; keep the record here and the stored data on PneumaSpace
node .appgov/appgov.mjs bring-back todo        # serve it again, with the data PneumaSpace kept
node .appgov/appgov.mjs publish-again todo     # only when PneumaSpace no longer has it: create it anew, with no stored data
node .appgov/appgov.mjs clear todo             # forget it; only once it does not serve
```

- **Take down** uses PneumaSpace's `remove`. The app stops serving; its record and history stay in R2 and its stored data stays on PneumaSpace. Your agents' submits are refused with a sentence saying you took it down.
- **Bring back** uses the plane's `resume`: the app serves its current release again, with its data.
- **Publish again** is only for an app PneumaSpace no longer has, for example one removed and purged there without the Host. `status` and the page then say it is not on PneumaSpace and that its stored data is gone. Publishing again creates it anew from the current version, with no stored data.
- **Clear** works only on an app that does not serve, so a serving app has to be taken down first. The centre forgets the app: its folder, history, versions, the changes that wait and their previews, its summary, stored view, plans and its entry in `apps.json`. The Host's PneumaSpace token cannot purge, so the app stays on PneumaSpace, removed, with all its stored data: its name, its app slot and its storage stay taken until the PneumaSpace owner purges it in PneumaSpace's console. The confirmation says so before you type the name, and afterwards the page names the console. Working copies stay where they are and can no longer submit.

On the apps page these are under "Take down or clear", at the bottom of an app's page with its details; that section is open when the app is not there. Apps you took down sit in their own collapsed section below the list of apps.

Reads come from stored views and summaries, which say what PneumaSpace answered when the app last changed. So the Worker also keeps one listing of every app on PneumaSpace (one call for all apps) as `runtime.json` in the bucket. A read of the page, `list` or `status` that finds it older than five minutes asks for a new one in the background and answers with the one it has; "Check now" on the page and `--check` on `status` and `list` ask now. The newer of the listing and the stored view wins, and the page and the CLI say when PneumaSpace last confirmed it. The four actions, and every submit, approval and undo, ask PneumaSpace live, in the container. The Worker makes that listing call itself, with the compatibility flag `global_fetch_strictly_public`, set in `cloudflare/wrangler.jsonc`, which the installer copies.

## Where things live

| What | Where |
| --- | --- |
| Each app's source, every version, the history, changes that wait | One tar object per app in the R2 bucket `<prefix>-folders` (`folders/<app>.tar`), plus a short summary for `list` (`summaries/<app>.json`) |
| Every app's summary in one object, so the list of apps reads one object besides the listing | `apps.json` in the same bucket. Each summary in it carries the etag of the summary it copies, and the list takes from it only those whose etag is the one listed, so it can be behind or removed without the list being wrong |
| What reading one app needs: its status, its newest 50 history entries and the plans for going back to the 8 nearest versions | The app's stored view in the same bucket (`views/<app>.json`), written with the folder. It names the folder's etag and its own shape; a reader that finds another etag or another shape has the container compute it again once, and it is stored for the next |
| Plans for going back further, worked out when you opened them | `plans/<app>.json` in the same bucket: the last 8 asked for, for the folder they were worked out from, by its etag; any change to the app makes them stale |
| The last listing of every app on PneumaSpace, with when it was taken | `runtime.json` in the same bucket |
| A working copy | Wherever you created or fetched it; the CLI mirrors the centre's `.pneuma-framework/` into it |
| The owner's sessions (the CLI's and the apps page's, each kind under its own prefix), the agents' tokens and the one-time codes that connect an agent, hashed | A Durable Object of the Worker |
| The apps page's files | The Worker's static assets, built by the installer from `local/web/` |
| The owner key, the Worker's secrets, the generated Wrangler configuration | `~/.appgov/hosts/<prefix>/` on the machine that ran the installer (mode 0700) |
| The owner session the CLI uses | `~/.appgov/hosts/<prefix>/session.json` |
| Each app's stored data and its releases | PneumaSpace |

## Limits

- **The threat model is an agent that makes mistakes, not one that attacks.** The app's tests run in the Host's container as a second unix user that cannot read the Host's files or its environment (the PneumaSpace token and the secret the Worker sends). They share the kernel, the network (with Internet access) and the disk. There is no second sandbox.
- Left out: screenshots, the data snapshot practice, starting Claude Code or Codex from the Host (the `drive` lane), and `record` and `review-all` modes. Only `personal` mode has been run.
- New apps only. Nothing imports an existing app or its data.
- Undo restores code; stored data is never put back.
- **An agent never opens the live app, and its change is checked on the preview.** The live app and its preview answer only to people signed in to PneumaSpace, and an agent's token is the centre's, not PneumaSpace's, so the agent gets 401: it never holds a PneumaSpace credential and never reads or writes the live app's stored data. Instead the app declares in `tests/preview.json` the requests that show it works, and during `submit`, once the change's preview answers its home page, the Host makes them itself with the token its probes use, so the app sees the PneumaSpace owner, through the identity headers PneumaSpace sets, and never the token itself: PneumaSpace removes it before a request reaches the app, and should a reply ever bring it back, the Host replaces it before it checks or shows the reply. A reply that is not as expected rejects the change (`preview_requests_failed`) and shows the agent, per request, what was sent and what came back. The agent writes that list, not code that runs with the token. The requests go only to the preview: a path cannot leave it, a redirect is a status and is never followed, and there are at most 20 requests, a body of at most 16 KB, 20 s each and 90 s in all. For an app without the file, the preview shows only that it starts, and `history` says so.
- **A preview starts with empty storage.** It is a separate app on PneumaSpace, and the declared requests run on that empty storage, so they cannot show how a change behaves on the live app's data. When a change that drops or rewrites stored data waits for you, you decide from the disclosure, not from seeing which stored values would go.
- **A preview takes one of the workspace's awake slots** (2 on PneumaSpace's default quotas) to start. When PneumaSpace refuses it because every slot is held, the Host puts the app's own live instance to sleep if that holds one (the release replaces it anyway), then waits up to a minute, asking PneumaSpace every 5 seconds who holds the slots, and publishes the preview again once one is free. It never puts another app to sleep, managed by it or not. When no slot comes free, the submit is refused (`preview_refused`): nothing is released, the preview is discarded before the answer, and the answer names the apps that hold the slots and says that trying again later works, since an awake app goes to sleep after 5 minutes without requests on the default policy. A release waits for a slot the same way and puts nothing to sleep. The Host publishes again only when PneumaSpace says a slot is free, at most three publishes in all: before pandazki/pneuma-space#71, PneumaSpace counted each refused start as a failure of the app, and five quarantined it.
- **A preview never runs the app's scheduled jobs.** It is an ephemeral app, so PneumaSpace never fires its schedules there, and the Host's requests cannot reach `/_pneuma-space/`, where PneumaSpace delivers a job. What a job does is shown only by the app's own tests, which call the job's code like any other function.
- PneumaSpace tokens cannot purge an app. When you clear an app, or the Host takes down the address of a first release that failed, the app stays on PneumaSpace, removed, and its name stays taken until the PneumaSpace owner purges it in the console. A create under a name that an app this Host does not manage already has on PneumaSpace is refused and says so; the Host never takes over or changes such an app. `create` and `status` print the address of the app's page on PneumaSpace that counts its requests, wakes and sleeps.
- One container per app, started on demand for what changes the app; reading it needs none, except a plan for going back past the 8 nearest versions and the whole history of an app with more than 50 entries.
- **The app's folder grows with every version.** Each version is a whole copy of the app (about 85 KB for the starter app), and every operation that changes the app loads and saves the folder whole: in the offline measurement below, 1 MB at 10 versions, 8.8 MB at 100 and 43 MB at 500, saved in 0.1, 0.7 and 3.5 s on one machine. A submit holds the connection open for the whole check, about 30 seconds in the runs below, about two thirds of it PneumaSpace releasing the preview and then the release (see the table below).
- The default rules find destructive SQL by matching text, as in the local edition.
- **On your machine, your session is a bearer credential.** An agent there runs as your OS user, so it can read `~/.appgov/hosts/<prefix>/session.json` and the owner key beside it. The CLI does not act as you without an interactive terminal and a typed word, and the agent instructions tell agents never to read those files or run those commands. Nothing stops a program that sends your session to the Worker itself, or runs the CLI in a terminal it makes. Against an agent that attacks, keep the owner key and sessions where agents do not run: another OS account or another machine.
- **For storage other than SQL, the Host relies on the agent's declaration.** The rules read SQL text and the manifest only. A change that deletes or rewrites `kv` entries, files or objects is released by the standing rule unless the agent submits it with `--one-way`.

## What has been run

On 2026-11-25, from macOS with colima, against a PneumaSpace deployment on Cloudflare with default quotas: the install (and two reruns), owner sign-in, a token for an agent, `create`, an ordinary change released by the standing rule, a change that dropped `identity.required` and waited for the owner (approving with the agent's token refused with 403, the owner's approve released it), `undo`, `fetch` into an empty directory with the token and a submit from there, a refused submit from a stale working copy, submits after the container was stopped, and a test that failed on purpose to show what the tests user can read (it could not read `/data`, the Host's home directory or the Host's environment, and had no `APPGOV_` variables). The offline tests (`npm run setup`, `npm run typecheck`, `bun test` in `cloudflare/`) cover the runtime adapter against a fake plane, the record round trip with a conflicting write, the Worker's rules for the owner and for agents' tokens, the apps page's sign-in and its rules against other sites, the page's views on the edition's answers, connecting with the page's command in an empty directory, and the whole loop with the CLI on one machine. On 2026-11-26 the apps page ran on the deployment, in headless Chrome, with a test app of its own beside the owner's two: the sign-in view on every path without a session, a wrong key refused, the cookie's attributes, a token, a CLI session and writes from another site refused, the list read from the summaries while the test app's container stayed stopped, an ordinary change released by the rule, a change dropping `identity.required` said no to on the page, a change declared one-way let through on the page (one request however often the button was pressed), going back past it on the page, and signing out. Saying no took 3.6 s, letting a change go live 16 to 18 s, going back 11 s.

The views were then measured again with stored views deployed, the same way (headless Chrome, signed in, from asking the browser for the view until it is on screen), five times each in three states: the test app's container awake, stopped, and right after rerunning the installer. Seconds, median and range; "before" is the one sample each of the run above, when every view but the list went through the app's container.

| View | Before | Awake | Container stopped | Right after a deploy |
| --- | --- | --- | --- | --- |
| The list of apps | 0.4 to 0.8 | 0.30 (0.25 to 0.35) | 0.39 (0.34 to 0.47) | 0.33 (0.31 to 0.33) |
| An app's page | 1.3 awake, 3.7 stopped, 14 after a deploy | 0.34 (0.32 to 0.37) | 0.55 (0.43 to 0.82) | 0.34 (0.32 to 0.42) |
| A waiting change | 2 | 0.35 (0.30 to 0.46) | 0.56 (0.52 to 0.76) | 0.36 (0.35 to 0.40) |
| Going back: the plan | not timed | 0.35 (0.31 to 0.37) | 0.40 (0.38 to 0.64) | 0.36 (0.30 to 0.40) |

With the container stopped, the app's Durable Object said it was still not running after each list and app-page read, and every view's `Server-Timing` named the stored view and no container step; a waiting change and a going-back plan then start the container on purpose, after answering. Inside the Worker, from `Server-Timing` over those 60 reads: the stored view from R2 27 to 196 ms (median 40), the folder's etag 20 to 99 ms (median 33), the two at once; the summaries 56 to 510 ms (median 82), the largest step. Requests from the machine that ran this entered Cloudflare at San Jose (SJC), where the Worker runs (it has no Smart Placement), and the bucket is in WNAM (western North America), so each read stays on one continent. `status` and `history` at the CLI with the container stopped: 0.71 s (0.56 to 0.71) and 0.58 s (0.54 to 0.68), the container still stopped after each.

The fallbacks, as seen. With the test app's stored view deleted by hand and its container stopped, the next open took 4.2 s (3.6 s of it the container starting and computing the view) and stored it; the one after read it in 0.48 s. With the build before (without stored views) still running in the app's Durable Object after a deploy, which happens when its container keeps running across the deploy (an object that stays active keeps its Worker version), the app's page and a going-back plan took 1.9 and 1.8 s through the reads that build knows, with nothing stored; after `container stop` the object ran the new build, the next open took 3.7 s and stored the view, and the one after 0.44 s.

What storing the view adds to a write, timed on its own (`view` in `--timing`): 0.64 to 0.70 s on an ordinary submit while the app had 2 to 4 versions; 1.1 to 1.5 s on a held submit and 1.4 to 1.8 s on an approval once it had 5 to 10, out of 18 to 31 s. It grows with the versions the view carries a going-back plan for; the view of the app with 10 versions is 74 KB. An approval sent after opening the change, whose warm had the container running within about a second, took 17.8 to 18.9 s (median 18.3); one sent with the container stopped took 18.4 to 20.8 s (median 18.4). The warm takes starting the container and loading the record (1.0 to 1.4 s in the cold ones) out of the approval, but PneumaSpace's release varies by more than that.

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

The savings taken change nothing that is checked: both probe requests go out at the same time instead of one after the other; putting the preview to sleep after its probe is no longer waited for; the preview is discarded while the release goes out (the release never draws on the preview's upload on this plane, and the submit still answers only once the discard is over); a lookup reads only the app's detail once its id is known, and nothing is read back right after a create; and `npm ci --ignore-scripts` reuses the install an earlier run made from the same `package.json`, lockfile and `.npmrc` in the same container, kept as it was before any test ran and out of the tests user's reach. Not taken: anything that skips or shortens a check (the tests, either probe, the preview), releasing before the preview answers or at the same time as it, running the tests and the preview at the same time (a change that fails its tests would then reach PneumaSpace as a preview), and uploading the release before the decision to release (what goes out has to be the copy checked against the sealed draft right before it is recorded). The two PneumaSpace releases, about 20 s of the 30, are the platform's own work, which this edition does not change. `create` took 44 s before and 32 to 38 s after, `undo` 9 s, `fetch` 1 s.

How the stored view grows with the app's age, measured offline (`bun run test/view-size.bench.ts` in `cloudflare/`): the edition on one machine with R2 as a map, each app grown to 10, 100 and 500 versions of the starter app's size, then a change submitted that waits for you. Milliseconds of the Worker's and the container's own work on that machine (on Cloudflare the container is slower), and bytes as R2 stores them and the browser receives them, before and after the bound.

| | 10 versions | 100 versions | 500 versions |
| --- | --- | --- | --- |
| Storing the view, in the submit: before | 12 ms, 14 KB | 802 ms, 139 KB | 20,016 ms, 1,387 KB |
| Storing the view, in the submit: after | 9 ms, 14 KB | 12 ms, 52 KB | 31 ms, 53 KB |
| An app's page: before | 1 ms, 23 KB | 5 ms, 137 KB | 24 ms, 644 KB |
| An app's page: after | 1 ms, 23 KB | 3 ms, 73 KB | 3 ms, 73 KB |
| A waiting change, before and after | 1 ms, 12 KB | 1 ms, 12 KB | 5 ms and 1 ms, 12 KB |
| Going back to v2: before (from the view) | 1 ms, 10 KB | 4 ms, 27 KB | 20 ms, 102 KB |
| Going back to v2: after, first open (container), then kept | 1 ms (in the view), 10 KB | 28 ms, then 4 ms, 27 KB | 126 ms, then 15 ms, 102 KB |
| `history` at the CLI: before (from the view, indented JSON) | 17 KB | 154 KB | 764 KB |
| `history` at the CLI: after | 17 KB, from the view | 99 KB, from the folder (compact JSON) | 490 KB, from the folder (compact JSON) |

On 2026-11-26, on the deployment, a Codex session given the page's sentence in an empty folder connected on the first try, about 26 s after the code was issued, and never printed the token; it then created an app (habit-check) and submitted a second version. A used, a wrong, a closed and an expired code were each refused with the same message and left the folder empty. Not run: several people, a Linux machine as the installer's host, waiting more than an hour for a preview to end, and anything beyond PneumaSpace's default quotas.
