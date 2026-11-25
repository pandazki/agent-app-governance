# agent-app-governance: the local edition

[中文版](./README.zh-CN.md) · [Back to the overview](../README.md)

This edition runs on your own computer, in Docker. It starts PneumaSpace, a small platform that runs web apps and keeps their data, and the Host, a service that stands between your coding agent and PneumaSpace. Your agent changes an app in its folder and submits the change; the Host checks it, has it approved by a rule or by you, publishes it, and writes it into the app's history, so that later you can see what changed and go back.

## What it covers

- **Apps you create here.** `create` makes a new app from PneumaSpace's app template: a small web app in TypeScript that can ask for a database, file storage, key-value storage and object storage. There is no way to bring in an app you already have, or its data.
- **Changes that go through the Host.** A change is recorded when your agent submits it. An app changed another way, for example from the PneumaSpace console, no longer matches its history.
- **Code, not data.** Going back puts an earlier version's code back on the app's address; the app's stored data stays as it is. This is not a backup of your data. An optional setup for PostgreSQL databases saves a copy before a change the rules mark as destroying data ([reference](./docs/reference.md#data-snapshots-for-postgresql)).

## Before you start

- **One computer, one person, and you trust the computer.** The Host has no login. Anyone who can reach its port can read your apps page and its API. What keeps your agent from approving its own change (a terminal for `approve`, a private link for the page) does not stop another program on the same computer.
- **Docker**, running, with a version of Compose that supports `additional_contexts` in a build, which the Host's image uses. On Linux, Docker Engine with the Compose and buildx plugins is enough.
- **The `gateway` container mounts the Docker socket** (`/var/run/docker.sock`), which gives it control of Docker on this computer.
- **Four free ports on 127.0.0.1:** 8080 (the apps), 8081 (the PneumaSpace console), 9000 (the object store) and 8090 (the Host). Nothing listens on other addresses. To use other ports, see [running beside other services](./docs/reference.md#running-beside-other-services).
- **Node.js 24 or newer.** The CLI alone runs on Node 18, but your agent runs each app's tests on your computer, and the app template asks for Node 24.
- **Internet access for the first build.** The images build PneumaSpace and pneuma-framework from GitHub at the commits `compose.yaml` pins, and pull base images from Docker Hub.

## Start it

From a clone of this repository:

```sh
cd local
docker compose up -d --build
```

The first build downloads base images and builds PneumaSpace and the Host from source, so it takes longer than later starts. Then six containers run: `gateway`, `runner`, `rustfs` and `redis` are PneumaSpace, `screenshot` takes the pictures on your apps page, and `host` is the Host.

## Create an app

```sh
node bin/appgov.mjs create todo
```

A name starts with a lowercase letter and has at most 30 lowercase letters, digits and hyphens. The Host copies the template into `apps/todo/`, adds the instructions for your agent and two hidden folders, `.pneuma-framework/` and `.appgov/`, runs the app's tests, starts the app once under a temporary name to see that it answers (the preview), and publishes it as version `v1`. It prints the address, how the release was approved, and the folder to open with your agent:

```
published v1 at http://127.0.0.1:8080/apps/todo/
risks: release_change; approved by: policy:auto
The app directory is /path/to/agent-app-governance/local/apps/todo. Open it with your coding agent.
```

`release_change` is the risk name the Host gives an app's first release, and `policy:auto` is the standing rule that approves ordinary changes. Creating an app never waits for you, in any mode.

`create todo` gives you the template's starter app under the name `todo`: one page that says "Hello, guest" and has a sign-in button. It is not a to-do list yet; ask your agent for one.

## Open the two pages

- The app: http://127.0.0.1:8080/apps/todo/
- Your apps page: http://127.0.0.1:8090/. It shows your apps, the history of each one, and the changes that wait for you.

Anyone can view the apps page. To decide on it (let a change go live, say no, go back to a version), open it from your owner link, which the Host prints in its log:

```sh
docker compose logs host | grep "owner link"
```

The line ends with `http://127.0.0.1:8090/#owner=` followed by a token. Open that link in your browser yourself, and do not give it to your agent. It stays the same when the Host restarts; to replace it, see [replacing the owner link](./docs/reference.md#replacing-the-owner-link).

The PneumaSpace console at http://127.0.0.1:8081/ is the platform's own admin page, without a login. Changing an app there goes around the Host, and the app's history then no longer matches what is live.

## Hand the app to your agent

Open the app's folder with the agent you use, and ask for a change in your own words:

```sh
cd apps/todo
claude
```

or

```sh
cd apps/todo
codex -c sandbox_workspace_write.network_access=true
```

The app's `AGENTS.md`, which Claude Code reads through `CLAUDE.md`, opens with the rules for the agent: look at `status` and `history`, edit the files, add a test, run `npm test`, and submit with `node .appgov/appgov.mjs submit "<what you asked for>"`. You do not need to tell the agent any of this.

- **Codex:** its default sandbox blocks connections to 127.0.0.1, so the app's tests cannot open a port and `submit` cannot reach the Host. The setting above allows them. Without it, approve the command when Codex asks, or the files change and nothing is published.
- **Claude Code** asks before it runs `npm` and `node`. Allow both.

The history records which agent submitted, from variables Claude Code and Codex set in their shells, and `unknown` when it cannot tell. To name it yourself, set `APPGOV_AGENT`. You can switch agents at any time: what the next agent needs is in the folder.

## What submit answers

The Host runs in one of three modes. Set it with `APPGOV_GOVERNANCE` in `local/.env` (copy `.env.example`), then run `docker compose up -d` again. `status` names the mode.

| Mode | What happens to a change |
| --- | --- |
| `record` | It is recorded and published. Nothing checks or approves it. |
| `personal` (the default) | The app's tests must pass, and the app must start in a preview unless previews are switched off. A standing rule approves ordinary changes; a change the rules call risky waits for you. With the default rules, a change is risky when visitors no longer have to sign in, or when new SQL in a code or `.sql` file drops a table, column or index, uses `ALTER TABLE` to drop or rename a column or the table, empties a table with `TRUNCATE`, or runs `DELETE` without `WHERE`. An `UPDATE` that changes stored rows is not caught. |
| `review-all` | The same checks, and every change after `create` waits for you. |

`submit` gives one of four answers:

| Answer | What it means | What to do |
| --- | --- | --- |
| `published vN at <address>` | The change is live as version N. | Open the app. |
| `rejected (<reason>)` | Nothing went live. Common reasons: the tests failed, a protected file or a file outside the app's own code changed, the preview did not start, nothing changed. | Let the agent fix it and submit again, or drop the edits with `node .appgov/appgov.mjs discard`. |
| `needs_approval <id>` | The change waits for you. The agent should stop and show you what it printed. | Decide on the apps page, opened from your owner link, or in your own terminal in the app's folder with `node .appgov/appgov.mjs approve <id>` or `node .appgov/appgov.mjs deny <id> "why"`. Each asks you to type the word to confirm. |
| `recorded vN, but it did not go live` | `record` mode only. The version is in the history, but it did not start, and the Host tried to put the address back on the version before. The next lines say whether that worked. | Fix the cause and submit again; with no new edits, the same version goes out as it is. Or go back. |

## See the history and go back

In an app's folder:

```sh
node .appgov/appgov.mjs status              # version, address, mode, files not submitted, what waits for you
node .appgov/appgov.mjs history             # every attempt: what was asked, by which agent, checks, approval, result
node .appgov/appgov.mjs list                # every app at a glance
node .appgov/appgov.mjs undo "why"          # back one version; run it again to go further back
node .appgov/appgov.mjs undo --to v2 "why"  # straight back to an earlier version
```

In `apps/` itself, `list`, `create <name>`, `status <name>` and `history <name>` work too. The Host keeps an `AGENTS.md` and a copy of the CLI there, so an agent started in `apps/` can answer "what apps do I have?".

`undo` goes back along the versions the current one was built on. It publishes the older version's code, checks that the app answers, and only then moves the history. It refuses while the folder has edits that were never submitted; submit them, or drop them with `discard`. On the apps page, every version the current one was built on has a "Go back to this" button (the page is in English or Chinese, following your browser's language).

A **one-way change** is one that putting the old code back cannot undo, such as dropping a column. In `personal` and `review-all` the rules mark it (by default, the SQL listed under `personal` above). In `record` mode it is marked only when the agent submits with `--one-way "<what is lost>"`. In every mode, going back past a one-way change is refused until you confirm it: in your terminal with `node .appgov/appgov.mjs undo --accept-one-way "why"`, which asks you to type `accept`, or on the apps page. Unless the PostgreSQL option saved a copy of the data, only the code goes back, and the older version may fail on the data as it is now.

## When something looks wrong

| What you see | What it means | What to do |
| --- | --- | --- |
| The agent says it is done, nothing new is live, and `status` lists files under `uncommitted` | The agent edited files and never submitted, or its sandbox stopped `submit`. | Ask it to submit, or drop the edits with `discard`. |
| `preview: none standing`, or the page says the preview isn't running, and approving is refused | A preview ends itself after an hour (`APPGOV_PREVIEW_TTL`), and approving needs the change's preview to be still running. The Host checks that it runs, not that anyone opened it. | Run `node .appgov/appgov.mjs preview <id>` or press "Show it to me again", look at it, then decide. |
| `recorded vN, but it did not go live`, or `status` says `the address serves vM, not vN` | `record` mode: version N is recorded, and the address still serves M. | Fix the cause and submit again (with no new edits, N goes out as it is), or go back. |
| `the Host cannot vouch for what the address serves` | The Host does not know which version the address serves: after a failed release or undo it could not put the address back, or an undo went out and could not be recorded. | Do what the line says. In the first case, the next release or undo that answers settles it. In the second, submitting and approving are refused until you run `undo`. |
| `undo` refuses, saying the way back crosses a change "that putting files back cannot undo" | A one-way change is in the way. | You decide: `undo --accept-one-way "why"` in your terminal, or go back on the page. |
| `cannot reach the Host at ...` | The Host is not running, or runs at another address. | Run `docker compose ps` in `local/`. For another address, pass `--host <url>`. |

## Where things live

| What | Where |
| --- | --- |
| The source, every version, the history, changes that wait | The app's folder, `apps/<name>/`: every version and the history in `.pneuma-framework/`, the changes that wait in `.appgov/` |
| The owner link's token and the pictures of your apps | The Docker volume `host-state` |
| Each app's stored data (database, files, key-value data, objects) and its published releases | PneumaSpace's Docker volumes: `gateway-data`, `runner-data`, `redis-data`, `rustfs-data`, and `postgres-data` with PostgreSQL |
| Data snapshots (PostgreSQL option only) | Extra databases on the PostgreSQL server |

An app folder has two hidden folders. `.pneuma-framework/` is written by pneuma-framework and holds every version and the history. `.appgov/` is written by the Host and holds its CLI and the changes waiting for a decision.

Docker puts the compose project's name in front of each volume's name, for example `agent-app-governance_host-state`. `docker compose down` keeps the volumes. `docker compose down -v` deletes them, and with them every app's stored data and the owner link; the app folders stay. Copying an app's folder to another computer copies its source and history, not its data.

## Limits

- One trusted computer and no login, as described under "Before you start".
- New apps only. Nothing imports an existing app or its data.
- Going back restores code. Stored data comes back only with the PostgreSQL option, only for a database on PostgreSQL, and only when going back past a one-way change. SQLite databases, files, key-value data and objects are never put back.
- The default rules find destructive SQL by matching text. They flag a `DROP` inside a string that never runs, and they miss a deletion built from variables.
- The preview starts with empty storage. It shows that the app starts and answers its home page without a server error, not that it works with your data or for a signed-in visitor. A change can pass when none of the app's own tests ran; `submit` and `history` then say so.
- While the `screenshot` service takes a picture of an app, the app's scripts can still send requests to the other services on the compose network, a preview's scripts included. To switch pictures off, put `APPGOV_SCREENSHOT_CDP=` in `.env`.
- What has been run: on an earlier build of this code, on macOS with colima and with Docker Desktop, real Claude Code and Codex sessions that changed apps and submitted them, changes that waited for the owner and were approved or denied, an undo past a one-way change, and the PostgreSQL snapshots. On this code: the offline tests, and one create, scripted change and undo on macOS with colima. Not run: a whole Linux machine, several users, a hosted setup.

[docs/reference.md](./docs/reference.md) covers the CLI, the modes and what each recorded guarantee means, the risk rules, one-way changes and undo, the PostgreSQL option, starting Claude Code or Codex from the Host (`bun run drive`), running beside other services, and the tests.
