# Reference: the local edition

[中文版](./reference.zh-CN.md) · [Back to the guide](../README.md)

The guide covers starting the stack and everyday use. This file covers the rest: the CLI in full, the modes, the risk rules, undo, taking an app down and clearing it, the PostgreSQL option, starting an agent from the Host, running beside other services, and the tests.

## The CLI

Every app has a copy of the CLI at `.appgov/appgov.mjs`, the apps folder has one, and `local/bin/appgov.mjs` is the source. It needs Node 18 or newer and nothing else.

| Command | What it does |
| --- | --- |
| `status [<name>]` | Whether the app is there (first, when it is not), the current version, the address, the version undo goes back to, the owner, the mode, whether a data snapshot capability is on and whether it covers this app, who manages the app on PneumaSpace, files not submitted, and changes that wait, each with its preview |
| `history [<name>]` | Every attempt, oldest first, with what was guaranteed for each |
| `list` | Every app: version, address, whether it is there, last change, changes that wait, files not submitted |
| `submit "<intent>"` | Take the working tree through the Host. `--one-way "<what is lost>"` declares that the change deletes or rewrites stored data, in any mode (see [one-way changes](#one-way-changes-and-undo)) |
| `discard` | Put the working tree back to the current version, dropping edits that were never submitted |
| `undo "<why>"` | Go back one version. `--to <version>` goes straight to an earlier one; `--accept-one-way` is the owner's confirmation to go back past a one-way change |
| `approve <id>`, `deny <id> [why]` | The owner's decision on a waiting change. Each needs a terminal and asks you to type the word |
| `preview <id>` | Publish a waiting change's preview again after it ended itself |
| `create <name>` | Create and publish a new app |
| `take-down [<name>] [why]` | The owner's: stop serving the app and keep everything (see [taking an app down](#taking-an-app-down-and-clearing-it)) |
| `bring-back [<name>] [why]` | The owner's: serve a taken-down app again, with the data PneumaSpace kept |
| `publish-again [<name>] [why]` | The owner's: create the app anew on PneumaSpace from its current version, once PneumaSpace no longer has it. It starts with no stored data |
| `clear [<name>]` | The owner's: forget an app that does not serve, and purge it on PneumaSpace. Asks you to type the app's name |
| `guide [--write <file>]` | Print a short block for an agent's user-level instructions: the Host's address, the apps folder and the commands. `--write` puts it in that file between markers and replaces it on later runs |

In an app's folder, commands act on that app; elsewhere, name it with `--app <name>` (or as a word, for `status`, `history`, `take-down`, `bring-back`, `publish-again` and `clear`). `--json` prints the Host's answer as JSON.

The CLI takes the Host's address from the first of these that has one: the `--host <url>` flag; `APPGOV_HOST`; a `.appgov/host.json` written by a Host, looked for in the current folder and each folder above it, then next to the CLI file itself, then in `apps/.appgov/host.json` beside the folder that holds the CLI (which is how `local/bin/appgov.mjs` finds `local/apps/.appgov/host.json`); and last `http://127.0.0.1:8090`. When it cannot reach the Host, it says which address it tried and where that address came from.

The history names the agent from `--agent <name>`, `APPGOV_AGENT`, or the variables the agent sets in its shells: `CLAUDECODE` or `CLAUDE_CODE_ENTRYPOINT` for Claude Code, `CODEX_THREAD_ID` or `CODEX_TOOL_CALL_ID` for Codex. With variables of both present and nothing naming the agent, it records `unknown` with both candidates and warns.

Exit codes: 0 when the command did what it was asked; 1 for a rejected change, a version that did not go live, or a usage error; 2 when the owner has to decide (`needs_approval`, or an undo past a one-way change); 3 when the Host refused the request or could not be reached.

## The three modes

`APPGOV_GOVERNANCE` sets the mode: `record`, `personal` (the default) or `review-all`. Every mode writes the same history. What the mode changes is what happens before a version is recorded.

- **`record`**: `submit` records the working tree as the next version and publishes it. There are no tests, no preview, no check of the folders a change may touch, no risk rules and no approval. After publishing, the Host asks the app's home page once, only to tell whether the release went live. When PneumaSpace refuses the build or the app does not answer, the version stays recorded, the Host puts the address back on what served before, the entry says the release failed, and `submit` exits 1. A later `submit` with no new edits releases that version as it is and records no new one; with new edits it records a new version on top, and the release takes both live.
- **`personal`**: every change is checked (below). The standing policy, `policy:auto` in the history, approves the risks the preset lists under `auto_approve`; every other risk waits for the owner.
- **`review-all`**: the same checks, and the owner approves every change, the ordinary ones included.

In `personal` and `review-all`, `create` runs the tests and the preview too, but it never waits: creating the app is approved by the standing policy in `personal` and recorded as the owner's approval in `review-all`.

Approving a waiting change applies the rules of the mode the Host runs in at that moment. A change that waited in `review-all` and is approved after the Host restarted in `personal` is approved by the standing policy, and the history also names the owner when the owner said yes.

Moving from `record` to a checked mode does not inherit what `record` let through. The checked modes take the folders a change may touch, the protected files and the test command from the Host's own copy (`overlay/appgov.scaffold.json`), not from the app's copy, and they compare a change with what the address serves. A version recorded in `record` mode that never went live is therefore checked before a checked mode takes it live.

## What each guarantee means

Every history entry lists the guarantees that held for it. A guarantee that is not listed did not hold.

| Guarantee | Meaning |
| --- | --- |
| `verified` | The app's tests (`npm ci --ignore-scripts && npm test`) passed on this content |
| `previewed` | This content started on PneumaSpace under a temporary name and answered its home page without a server error (any status below 500) before release |
| `approved` | An approval exists: the standing policy's or the owner's |
| `sealed` | What was published and recorded is byte for byte what was checked |

| Entry | Guarantees |
| --- | --- |
| Released in `personal` or `review-all` | `verified`, `approved`, `sealed`, and `previewed` when previews are on |
| Waiting for the owner, or denied | What its checks earned: `verified`, and `previewed` when the preview passed |
| Rejected by the checks | What passed before the failure, often nothing. A draft that changed after it was checked: nothing |
| Approved, but the release failed | `verified`, `approved`, and `previewed` when it ran. Nothing was recorded, so not `sealed` |
| A version recorded earlier that a checked submit released as it is | The release entry carries what held for that release |
| Anything in `record` mode, an undo, a data snapshot | Nothing |

An undo entry claims nothing about the version it makes current; that version's own entry says what held when it was released.

## What a change goes through in `personal` and `review-all`

1. The working tree is copied into a draft. A change may touch only `src/`, `public/app/`, `pneuma-space.json`, `package.json`, `package-lock.json` and `AGENTS.md`; anything else is rejected as `outside_writable_roots` before any check runs. A change to `sdk/`, `ui/`, `public/ui.css`, `public/ui.js`, `appgov.scaffold.json` or `CLAUDE.md` is rejected as `protected_file_changed`. These lists are in `overlay/appgov.scaffold.json`.
2. `npm ci --ignore-scripts && npm test` runs in another copy, outside the app's folder, because the tests are code the agent wrote. The entry records how many tests ran and how many of them are the app's own, from a JUnit report Node's test runner writes on Node 24 and newer; with another runner the app's share is recorded as unknown. When a change touches `src/` or `public/app/` and none of the app's own tests ran, `submit` says so in one line. It does not block the change.
3. The preview: the draft is published as a temporary app named `<app>-pv` plus four characters of the change id, with its own empty storage. It ends itself `APPGOV_PREVIEW_TTL` seconds after it is published (default 3600; PneumaSpace refuses more than its `ephemeral_max_ttl_seconds`, 3600 unless raised with `PUT /api/policy`). Each waiting change holds one temporary app until it is decided or its preview ends. A preview PneumaSpace refuses, because the tenant has no temporary app left or the life asked for is too long, is rejected as `preview_refused`, which is not a failed check.
4. The risk rules classify the change, and the approval rules decide whether it waits for the owner.
5. The Host takes a content hash of the draft when it diffs it and compares it again on the copy it is about to publish. A draft that changed in between is rejected as `draft_changed_after_check`.
6. The release. When PneumaSpace refuses it (`publish_failed`), the address was not touched; when the app does not answer (`published_unhealthy`), the Host puts the address back on what served before. Either way the change is rejected and no version is recorded.

A change that waits for the owner keeps its preview up until it is decided or the preview ends. Approving needs the preview to stand at that moment: once it has ended, approving is refused with `preview_gone` (409), and when PneumaSpace does not answer, with `preview_unknown` (502). `preview <id>`, or "Show it to me again" on the page, publishes the checked draft again with a new end. Approving or denying discards the preview. With `APPGOV_PREVIEW=off` there is no preview, approving needs none, and no entry carries `previewed`.

These are never part of a version: `node_modules`, `.pneuma-framework`, `.appgov`, `.git`, `dist`, `.work`, `.claude`, `.codex`, `.vscode` and `.idea` folders, the `.pneuma` folder pneuma-skills keeps, a top-level `data` folder, and `.env`, `.env.local` and `.DS_Store` files.

### When the Host cannot vouch for what the address serves

`status`, `list` and the page then say so, whatever versions they name, and say what to do. There are two cases.

- After a failed release or undo, the Host could not put the address back, so nobody has seen the address answer since. Nothing is refused. The next release or undo that answers settles it.
- The current version has served before, and the address now serves an older one: an undo went out and could not be recorded, or something outside the Host moved the address. A submit or an approval would put the current version's code back on whatever data the older one serves, so both are refused with `serving_uncertain` (409) and write nothing. An undo that answers ends it.

## The risk preset

Which change carries which risk is set in a JSON file, not in code. The Host reads `policy/personal.json` unless `APPGOV_POLICY_FILE` names another file. For the container that is a path inside the container, so mount your file there too. A field the Host does not know stops it at start, so a misspelled rule cannot pass a change silently. Each history entry that carries an approval names the preset it was decided under.

| Part of a preset | What it says |
| --- | --- |
| `change` | The risk every change carries, and a lighter one when a change stays under given paths |
| `paths` | Changes under these paths carry this risk, for example payment code that always needs the owner |
| `manifest` | The risk for each fact about `pneuma-space.json`: a capability added or removed, a capability that keeps stored data removed (`storage_removed`), the runtime changed, sign-in no longer required |
| `content` | Text patterns over changed files. A pattern counts when what it matches occurs more often than before the change |
| `auto_approve` | The risks the standing policy may approve in `personal` mode. Every other risk waits for the owner |

A `paths`, `manifest` or `content` rule can carry `one_way: true`, which marks a change it finds as one-way. The rules of `policy/personal.json`:

| What the rules find on disk | Risk | `personal` | `review-all` |
| --- | --- | --- | --- |
| Source or browser files changed | `source_code_change`, or `additive_ui` when only `public/` changed | standing policy | owner |
| A capability added to `pneuma-space.json` | `definition_additive` | standing policy | owner |
| A capability removed, or the runtime changed | `release_change` | standing policy | owner |
| A capability that keeps stored data (`db`, `kv`, `files`, `object`) removed: PneumaSpace keeps the data, but the app no longer reaches it | `destructive_definition`, one-way | owner | owner |
| Visitors no longer have to sign in | `policy_change` | owner | owner |
| New `DROP TABLE/COLUMN/INDEX`, `ALTER TABLE ... DROP/RENAME`, `TRUNCATE`, or `DELETE` without `WHERE`, in a `.ts`, `.js` or `.sql` file (and their variants) | `destructive_definition`, one-way | owner | owner |

In `record` mode a submit is neither classified nor approved by these rules, though the Host still loads and checks the file when it starts. The SQL rules are text patterns. They do not match an `UPDATE`, or a `DELETE` with a `WHERE`, so in `personal` a change that rewrites or deletes some stored rows goes live without the owner. They flag a `DROP` in a string that never runs, and miss a deletion built from variables. No rule reads deletions from files, key-value data or objects: a call that deletes is in every ordinary app (deleting a to-do item), and a rule that fired on it would teach the owner to stop reading. For that storage the Host relies on the submitter's `--one-way`. Treat the file as a starting point for your own.

## One-way changes and undo

- **Undo walks back.** Each `undo` goes to the version the current one was built on: v5, then v4, then v3. `undo --to <version>` goes straight to one of those. A version that the current one was not built on cannot be an undo target; to bring it back, submit its files again from `.pneuma-framework/versions/<version>/`. A new change after an undo gets a new number.
- **Each step** publishes the older version, checks that it answers, and only then moves the history and puts the older files back in the working tree. Undo refuses to start while the working tree has edits that were never submitted. If the tree is edited while the undo runs, the version still goes out and the tree is left as it is, with a note.
- **Which changes are one-way.** The preset's rules mark some: in `policy/personal.json`, the destructive SQL rule and the rule for dropping a capability that keeps stored data. Whoever submits can mark any change, in every mode, with `submit --one-way "<what is lost>"`; the agent instructions in every app say to do so whenever a change deletes or rewrites data the app already stored, in any kind of storage, because the rules read only SQL text and the manifest. The preset sets the least a change needs and a declaration can only raise it. In `record` mode it marks the version one-way. In `personal` and `review-all` the change waits for the owner whatever its risks (approval route `declared-one-way`; the standing policy and any subject but the owner are refused, also after the Host restarts in another mode). The risks stay what the rules found, and the owner reads the submitter's words in a line of their own that says they are the agent's statement, not a finding of the rules. Once approved, the version is recorded one-way, with what the rules found and then `declared one-way when it was submitted: "<words>"` as its reason, and with the words alone in `declared_one_way`. Before the owner approves a one-way change, the Host tells them what approving costs and whether it can put stored data back.
- **Going back past a one-way change waits for the owner, in every mode.** The undo is refused (`crosses_one_way_change`; the CLI exits 2) and nothing is touched. The message lists each one-way version and why, and says which case applies: (a) the Host saved the data before that change, the data returns to that snapshot, and everything stored since is set aside and will not be in the app; or (b) only the code returns, and the older version may fail on today's data. The API answer carries `data_restore: "snapshot"` or `"none"`.
- **The owner confirms** with `undo --accept-one-way "<why>"` in a terminal, typing `accept`, or on the page from the owner link. The confirmation carries the version the plan started from; if another version went live in between, the Host answers `plan_changed` (409) and nothing changes. The Host answers 403 to anyone but the owner. The history entry records `one_way_crossed`, `confirmed_by`, and in case (a) where the replaced data went. When a version gone back past was declared one-way by its submitter, the undo's answer lists it in `declared_one_way` with the words, and the CLI prints them: going back puts back its code, not what it did to stored data.

## Taking an app down and clearing it

Whether an app is there comes from two places: the Host's own record (whether the owner took it down through this Host, which is a `take_down` entry in the history not followed by a `bring_back` or `publish_again` one) and what PneumaSpace says about the app. The Host asks PneumaSpace at every `status`, for every app in `list` and on the page, and before every submit, approval and undo; on this edition every read asks it live. `status` and `list` carry PneumaSpace's answer as `runtime` (`serving`, `removed`, `gone` or `unknown`, with `checked_at`, and `asleep: true` while PneumaSpace has a serving app asleep after being idle, which `status` then says is normal), the owner's take-down as `taken_down` (who, when, through what), and the two together as `standing`. `status` also carries `choices`, what the owner may do now, and `clearing`, what clearing would delete and leave.

| `standing` | What it means | What the owner may do |
| --- | --- | --- |
| `running` | PneumaSpace serves the app, and nobody took it down here | Take it down |
| `down` | The owner took it down through this Host. PneumaSpace keeps it removed, with its data, or no longer has it | Bring it back, or publish it again when PneumaSpace no longer has it; clear it |
| `removed_elsewhere` | PneumaSpace holds it removed, with its data, but not through this Host | Bring it back, or clear it |
| `vanished` | PneumaSpace has no such app any more (or is purging it), and this Host did not take it down, so its stored data is gone | Publish it again, or clear it |
| `unconfirmed` | PneumaSpace did not answer | Nothing, until it answers |

An app the Host has as taken down that PneumaSpace serves again (brought back in its console) stays `down`. The owner can take it down again, or bring it back, which records it as back without touching PneumaSpace.

What each act does:

- **Take down** calls PneumaSpace's `remove`, with the Host's manager name. The address stops answering; PneumaSpace keeps the app's stored data, and the Host keeps the folder, the versions and the history. The history gets a `take_down` entry naming who did it and through what (`"channel": "owner-page"` from the page), with the owner's reason in its intent. Changes that wait stay: approving one is refused until the app is back, and saying no still works.
- **Bring back** serves the current version again with the data PneumaSpace kept. The local gateway has no resume action, so the Host publishes the current version onto the removed app, and the gateway registers it again with the same id and the same data. The Host then asks the home page once; the `bring_back` entry says so when it did not answer.
- **Publish again** is only for an app PneumaSpace no longer has. It publishes the current version as a new app with empty storage, and the `publish_again` entry says that the data the app stored before is not there any more.
- **Clear** checks first that `confirm` is the app's name, then that PneumaSpace does not serve the app: it never goes in one step from `running`. It discards the previews of the changes that wait, purges the app on PneumaSpace with all its stored data when PneumaSpace holds it removed, and then deletes the app's folder, `apps/<name>/`: the source, every version, the history and the changes that wait. That folder is also where your agent works. No history is left to write in; the Host's log keeps one line saying who cleared the app. Before the purge, a data snapshot capability that can be asked to let go is asked (`discardAll`, with every snapshot the history names): with the PostgreSQL option, every snapshot database of the app and every database its undos set aside are dropped, also those the history does not name, so that PneumaSpace's purge can drop the app's role. It is asked whether or not this Host may purge. If it cannot let go, nothing else is cleared (`data_snapshot_discard_failed`) and clearing again asks again; when PneumaSpace then refuses the purge, nothing else is cleared either, and the refusal says what was already dropped. `status` lists the snapshots in `clearing.deletes`, and the CLI and the page show that line before you type the name. A capability that cannot be asked keeps its snapshots, and they are listed in `clearing.keeps` instead.

Whether clearing purges is a capability of the Host's PneumaSpace runtime (`SpaceRuntime.purge`), not a setting. The local gateway lets the Host purge a removed app. The Cloudflare edition's plane gives the Host no purge authority, so there clearing leaves the app removed on PneumaSpace, with its data, for the PneumaSpace owner to purge.

**The CLI.** `take-down`, `bring-back`, `publish-again` and `clear` take the app's name as a word outside an app's folder; any other words are the owner's reason. Each refuses to run without a terminal, shows the app's standing and what the act does (for `clear`, what it deletes and what stays), and asks you to type the command's name, or for `clear` the app's name. It sends `APPGOV_OWNER` (default `user:me`) as the subject.

**The routes.** The first three answer `standing`, `runtime`, `taken_down` and a `note` that says what happened. `clear` answers `deleted`, `kept`, `data_discarded` (what the data snapshot capability dropped first, when it was asked) and `space_holds` (whether PneumaSpace still holds the app). The JSON API's rule for writes applies: no `Origin` or `Sec-Fetch-Site`, and `content-type: application/json`.

| Route | Body |
| --- | --- |
| `POST /apps/<name>/take-down`, `/bring-back`, `/publish-again` | `subject` (only the app's owner is accepted), and optionally `reason` |
| `POST /apps/<name>/clear` | The same, and `confirm`: the app's name |
| `POST /owner/apps/<name>/take-down`, `/bring-back`, `/publish-again`, `/clear` | The page's, with the owner link's token. The subject is the app's owner and the entry says `"channel": "owner-page"`. Optionally `reason`; for `clear`, `confirm` |

**Refusals.** None of them writes anything, and the CLI exits 3.

| Code | Status | When |
| --- | --- | --- |
| `app_down` | 409 | A submit, an approval or an undo while the owner has the app taken down. The message names who took it down and when, and says that the owner brings it back |
| `app_removed_elsewhere` | 409 | The same, while the app is taken down on PneumaSpace, not through this Host |
| `app_vanished` | 409 | The same, while PneumaSpace has no such app: a release would only create it again, empty. The owner publishes it again or clears it |
| `owner_required` | 403 | Taking down, bringing back, publishing again or clearing, asked by anyone but the app's owner |
| `confirm_name` | 400 | Clearing without the app's name, exactly, in `confirm` |
| `clear_running` | 409 | Clearing while PneumaSpace serves the app: take it down first |
| `cannot_take_down`, `cannot_bring_back`, `cannot_publish_again` | 409 | The act does not fit the app's standing now: for example bringing back an app PneumaSpace no longer has, or publishing again one it still has |
| `space_unknown` | 502 | PneumaSpace did not answer, so whether the app is there is unknown |
| `space_refused` | 502 | PneumaSpace refused the remove, the publish or the purge, or did not answer it |

## Data snapshots for PostgreSQL

This is an optional practice, not something pneuma-framework or PneumaSpace promises. With it, the Host copies an app's PostgreSQL database right before a one-way change first goes live, and a confirmed undo past that change puts the copy back. The code is `src/data-snapshot-postgres.ts`; the copy is PostgreSQL's `CREATE DATABASE ... TEMPLATE`.

Setup, before an app first declares a database (`"db": {}` in `pneuma-space.json`):

1. Start PostgreSQL: `docker compose --profile postgres up -d`.
2. Put new databases on PostgreSQL:

   ```sh
   curl -X PUT http://127.0.0.1:8081/api/policy -H 'content-type: application/json' -d '{"db_backend":"postgres"}'
   ```

   From then on, an app's first database is a PostgreSQL database of its own. An app that already has a database keeps it; PneumaSpace does not move data between engines.
3. In `local/.env`:

   ```sh
   APPGOV_DATA_SNAPSHOT=postgres-template
   APPGOV_DATA_SNAPSHOT_URL=postgresql://postgres:pneuma-local@postgres:5432/postgres
   ```

   Run `docker compose --profile postgres up -d` again so that the Host restarts with them. `status` then shows `data snapshot: postgres-template`. With the name and no URL, or any other name, the Host stops at start and says why.

**Snapshot.** Right before a release takes a one-way change live for the first time, the Host asks PneumaSpace which PostgreSQL database the app uses, stops the app, and copies the database to `snap_<app>_<version>_<time>`, closed to every role but superusers and marked with a comment naming the app, the version, the source database and the time. Before the Host promises anything, it asks whether the practice covers the app: it covers an app whose database PneumaSpace put on PostgreSQL. For an app on SQLite or without a database, the owner reads before approving that no snapshot is taken and the stored data cannot come back; approved, the change goes live without a snapshot, and its entry says why. `status` says the same (`data_snapshot_coverage`). If the owner was told the data would be saved and the app has left PostgreSQL by the time of the approval, nothing goes live (`data_snapshot_failed`), and the change has to be submitted again. If a one-way release went out and did not answer, the next attempt keeps the first snapshot rather than copying data the failed attempt may already have changed.

**Restore.** The snapshot's name comes from the app's history, which the agent can write, so the Host first checks that the name has this app's prefix and that the database is owned by a superuser and carries the mark for this app; a name that fails is refused as `data_snapshot_refused` before anything changes. Then the older code goes out and has to answer, the app's database is renamed to `<database>_replaced_<time>` (nothing is dropped), a fresh copy of the snapshot takes its name, and the app has to answer again before the history moves. Code goes first because the build that dropped the data usually drops it again when it starts.

Limits:

- Only the PostgreSQL database is covered. Files, key-value data and objects stay as they are. Apps on SQLite are not covered, nor an app that got its database before the policy said `postgres`.
- A snapshot is taken only before a one-way change. A restore drops from the app everything stored since that moment; it is kept only in the replaced database.
- Each snapshot and each restore is a full copy; time and disk grow with the database. The app is stopped while its database is copied or swapped.
- Between the older code going out and the data coming back, the older code runs on the newer data and may answer errors.
- `APPGOV_DATA_SNAPSHOT_URL` is superuser access to every app's database on that server.
- Snapshots and replaced databases stay as long as the app does: every recorded version stays a possible undo target, and nothing drops them while the app lives. Clearing the app drops them before PneumaSpace purges it, including ones a Host from before this rule left behind (their tables belong to the app's PostgreSQL role, so the purge would fail while one was left).

## Starting the agent from the Host (`bun run drive`)

Instead of opening an agent in the app's folder, you can have the Host start Claude Code or Codex on a copy of the app and take the result through the same checks. This is the shape a product that runs its own conversation would use. It runs on your machine, where `claude` and `codex` are signed in, against the running stack.

It needs Bun 1.4.5, Node 24 or newer, the PneumaSpace source at the commit `compose.yaml` pins (for its CLI, `appctl`), and the compose stack running. To get that source, clone PneumaSpace and check out the commit in the `x-space-context` line of `compose.yaml`; `appctl` needs no install:

```sh
git clone https://github.com/pandazki/pneuma-space.git "$HOME/pneuma-space"
git -C "$HOME/pneuma-space" checkout 6e7353809338901a604973e9fe90d1cafe4cb3cc
```

```sh
cd local
bun run setup                                       # once: pneuma-framework into vendor/, then bun install
export APPGOV_SPACE_CLI="$HOME/pneuma-space/cli/appctl.ts"

bun run drive change todo "add a due date to each item" --agent claude-code
bun run drive change todo "sort by due date" --agent codex
bun run drive change todo "leave a note" --agent scripted
```

`--agent scripted` needs no sign-in: it writes the request into `public/app/note.txt`, which is enough to run a change through the Host. `bun run drive` with no arguments lists the other commands (`create`, `status`, `history`, `undo`, `discard`, `approve`, `deny`, `preview`).

`drive` takes its settings from the environment, as the container does. When the stack runs on other ports or under another project, set `APPGOV_SPACE_ADMIN` (the PneumaSpace admin address, for example `http://127.0.0.1:48361`), `APPGOV_SPACE_INGRESS` and `APPGOV_SPACE_PUBLIC` (where the apps are), `APPGOV_APPS_DIR`, and `APPGOV_MANAGER` when the stack sets one; with another manager name the Host refuses to change the stack's apps (`managed_elsewhere`). Set `APPGOV_GOVERNANCE` and `APPGOV_POLICY_FILE` to what the stack uses.

A change started this way, an owner's approval and an undo all write a version over the working tree, so each refuses to start while the tree has edits that were never submitted. Do not run `drive` and an agent in the folder against the same app at the same moment. When the Host starts Claude Code, nobody answers its permission prompts, so a tool call outside the allowed list is denied and printed as `[claude:denied ...]`.

## Running beside other services

The stack listens on four ports, all on 127.0.0.1. When one is taken, set another in `.env`:

| Variable | Default | What listens there |
| --- | --- | --- |
| `PNEUMA_SPACE_HTTP_PORT` | 8080 | The apps, at `/apps/<name>/` |
| `PNEUMA_SPACE_ADMIN_PORT` | 8081 | The PneumaSpace console and admin API |
| `PNEUMA_SPACE_OBJECT_PORT` | 9000 | The object store |
| `APPGOV_HOST_PORT` | 8090 | The Host: your apps page and the API the CLI calls |

The Host records its address in `.appgov/host.json`, in the apps folder and in every app, when it starts and when it creates or opens an app, so the CLI copies there find it on any port. How the CLI picks an address is under [The CLI](#the-cli). With the apps folder outside `local/`, `node bin/appgov.mjs` does not see the record: run the copy in that folder, or pass `--host`.

A second stack beside the first needs its own compose project name, Docker network name, ports and apps folder. `PNEUMA_SPACE_NETWORK` sets the network's name and tells the gateway the same name. From a second clone of the repository, put these lines in that clone's `.env`. From the same clone, put them in another file and pass it to every `docker compose` command for that stack with `--env-file`; that file replaces `.env` for the command, so repeat any line of `.env` you rely on.

```sh
COMPOSE_PROJECT_NAME=aag-second
PNEUMA_SPACE_NETWORK=aag-second
PNEUMA_SPACE_HTTP_PORT=48360
PNEUMA_SPACE_ADMIN_PORT=48361
PNEUMA_SPACE_OBJECT_PORT=48362
APPGOV_HOST_PORT=48363
APPGOV_APPS_DIR=/path/to/second-apps    # create it first, so that it is yours
```

Then run `docker compose --env-file second.env up -d --build`, and once `node bin/appgov.mjs create notes --host http://127.0.0.1:48363`. After that, the CLI in `/path/to/second-apps` or in `/path/to/second-apps/notes` reaches the second Host with nothing set.

On Linux the Host has to write app files as you, or your agent cannot edit them. Started as root, it becomes whoever owns the mounted apps folder (`host-entrypoint.sh`). The repository ships an empty `apps/` so that the folder is yours before Docker mounts it. If you point `APPGOV_APPS_DIR` elsewhere, create that folder first; a folder Docker creates belongs to root.

The Host answers only to the host names `localhost`, `127.0.0.1` and `[::1]`, the host name in `APPGOV_HOST_URL`, and the address in `APPGOV_HOST_BIND` when that is a single address. Any other name, a LAN address or `host.docker.internal` included, gets 403 `wrong_host_name`. To reach it by another name, set `APPGOV_HOST_URL` to the address with that name.

## The app's folder

| Path | What it is |
| --- | --- |
| `AGENTS.md`, `CLAUDE.md` | How to work on the app: the rules for the agent, then PneumaSpace's guide to the template |
| `pneuma-space.json` | What the app asks PneumaSpace for (capabilities) |
| `appgov.scaffold.json` | Which folders a change may touch, which files are protected, and the checks |
| `.pneuma-framework/versions/vN/` | The clean source of every recorded version |
| `.pneuma-framework/history.jsonl` | One line per attempt, with the guarantees that held |
| `.pneuma-framework/record.json` | The version counter and the current version |
| `.pneuma-framework/build-threads.json` | Each request, proposal and decision in order |
| `.pneuma-framework/release-rollout.json` | Which version the address serves, and the one before |
| `.appgov/appgov.mjs` | The CLI |
| `.appgov/host.json` | The Host's address |
| `.appgov/app.json` | The app's name, owner and creation time |
| `.appgov/pending/`, `.appgov/drafts/` | Changes that wait for the owner, and their drafts |

The two hidden folders have different writers. pneuma-framework writes `.pneuma-framework/`: every version and the history. The Host writes `.appgov/`: its CLI, its address and the changes waiting for a decision. Neither folder is part of a version or of what the Host publishes.

Copying the folder to another machine and pointing a Host at it continues the same history. It does not copy the app's stored data.

## On one machine: what the owner checks do

- `approve`, `deny`, `undo --accept-one-way`, `take-down`, `bring-back`, `publish-again` and `clear` refuse to run without a terminal, and the Host answers 403 when a decision that needs the owner comes from another subject. The owner is the one named in the app's `.appgov/app.json`, taken from `APPGOV_OWNER` (default `user:me`) when the app was created. The Host takes the subject from the request, so this stops an honest agent from approving its own change, not another program on the machine.
- The owner link: the Host makes a random token once, keeps it in its state volume (`/state/owner-token`, readable by the Host's user only) and prints the link at every start. The token rides in the part of the address after `#`, which a browser sends to no server; the page keeps it in that tab and sends it with each decision, from the page's own origin. A decision on the page passes the same checks as one in a terminal and writes the same history entry, plus `"channel": "owner-page"`. A program that can read the Host's log can read the link.
- The Host's JSON API refuses what only a browser would send: a request that changes something must not carry `Origin` or `Sec-Fetch-Site` and must say `content-type: application/json`. This keeps a web page from acting through the API; it is not authentication.
- Pictures: the `screenshot` service is a headless Chrome. The Host asks it for a picture of an app when a version goes live, when a waiting change has a preview, and again after `APPGOV_SCREENSHOT_REFRESH_HOURS` (default 24). Each picture is taken with no cookie, so an app that asks visitors to sign in gets no picture. A pictured page's own requests may go only to its own address or over https, but a WebSocket and anything a frame from another site requests are not filtered, so a page's scripts, a preview's included, can send requests to every service on the compose network. PneumaSpace's admin API there takes some writes without a login, such as stopping an app. Where that matters, set `APPGOV_SCREENSHOT_CDP=` to switch pictures off; nothing else changes.
- Managers on PneumaSpace: every app the Host releases, and every preview, names the Host as its manager (`APPGOV_MANAGER`, default `appgov`). PneumaSpace refuses a write to such an app that does not carry that name, and its console asks you to type the name first. The name is not a secret, so this guards against mistakes only. Before each write, the Host asks PneumaSpace who manages the app. Another name: the write is refused with `managed_elsewhere` (409) and the message says how to settle it; saying no to a waiting change still works. No manager: the write goes ahead and marks the app as this Host's, and the result says so.

### Replacing the owner link

The link stays the same when the Host restarts. To retire it and make a new one, delete the token and restart the Host; the last "owner link" line in the log is then the new link:

```sh
docker compose exec host rm /state/owner-token
docker compose restart host
docker compose logs host | grep "owner link" | tail -1
```

A page opened from the old link can no longer decide; open the new one.

## Tests and the framework source

The Host uses four pneuma-framework packages (`@pneuma-framework/core`, `host-kit`, `backend-codex`, `backend-claude-code`). They are not published, so they come from source at one commit, set in one place: the `x-framework-context` line of `compose.yaml`, beside the PneumaSpace pin.

- The Host's image takes that commit from GitHub as a build context of its own, as it takes PneumaSpace. `docker compose up` needs nothing else.
- On your machine, `bun run setup` reads the same line, fetches that commit into `vendor/pneuma-framework` (ignored by git), runs `bun install --frozen-lockfile`, and links the two framework packages the shared Host code imports into `../host/node_modules` (ignored by git).

```sh
cd local
bun run setup         # once, and again after the pin moves
bun run typecheck
bun test              # offline: an in-memory PneumaSpace and scripted agent CLIs; apps/ and vendor/ are left out
```

`bun run dev:page` serves the apps page over sample apps in every state, without Docker; `bun run build:page` builds the page into `web/dist`.

To move to another framework commit, change it in `compose.yaml` and run `bun run setup`. If that stops because the framework's packages changed their dependencies, run `bun install` and commit the new `bun.lock`. To build from local checkouts instead of the pinned commits, set `APPGOV_SPACE_CONTEXT` or `APPGOV_FRAMEWORK_CONTEXT` in `.env` (see `.env.example`).
