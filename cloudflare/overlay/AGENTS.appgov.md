# This app is governed: read this part first

This directory is a working copy of a published app whose record is kept by an appgov Host on Cloudflare (the centre). The centre holds the app's folder: its source, every version and the history. This copy mirrors it: every version and the history are in `.pneuma-framework/`, which pneuma-framework writes at the centre; the CLI and the centre's address are in `.appgov/`. Any coding agent can pick it up; the rules in this part are the whole protocol.

The part after this one, "PneumaSpace app on Cloudflare", describes the platform, the manifest and the native services. Use it for writing code. **Never publish to PneumaSpace yourself.** An app here goes live only through this CLI's `create` and `submit`. Do not publish, deploy or host it with any other tool, skill or service your environment offers, and do not create accounts or projects elsewhere for it.

## Changing this app (read this before the first edit)

1. See where things stand: `node .appgov/appgov.mjs status` and `node .appgov/appgov.mjs history`. `status` shows the active version, the address, the files you changed here and have not submitted, and anything waiting for the owner. It also says which mode the Host runs in and what `submit` does there. `history` shows what was asked for, what changed and what was guaranteed for each attempt, oldest first. `node .appgov/appgov.mjs list` shows every app the centre keeps.
2. Edit files in place. You may change `app/`, `tests/`, `pneuma-space.json`, `package.json`, `package-lock.json`, `PRODUCT.md`, `DESIGN.md` and this file. `appgov.scaffold.json`, `CLAUDE.md` and `.gitignore` are protected. `appgov.scaffold.json` is the machine-readable form of these boundaries.
3. Add a test for every change in behaviour, under `tests/` in a file named `*.test.mjs`, and run `npm test` before you submit.
   For each route you add or change, also add a request to `tests/preview.json` (create it if the app has none), and keep the requests already there answering. `submit` makes them on the preview, in order, as the PneumaSpace owner, on storage that starts empty, so one request can store something and a later one read it back:
   ```json
   {"requests": [
     {"method": "POST", "path": "/api/items", "body": {"title": "Dune"}, "expect": {"status": 201}},
     {"path": "/api/items", "expect": {"status": 200, "contains": "Dune"}}
   ]}
   ```
   `method` is GET (the default), POST, PUT, PATCH or DELETE; `path` starts with one `/` and stays inside the app; `body` is JSON, never on a GET; `expect` needs `status` and may give `contains`, text the reply must include. No other fields; at most 20 requests, each answered within 20 s. A file that is not valid is rejected as `invalid_preview_requests`, saying what is wrong. A reply that is not as expected rejects the change as `preview_requests_failed`, and for each failing request the answer shows what was sent, what was expected and what the preview answered: fix the app, or the request if it expects the wrong thing. Your token does not open the live app or the preview, by design; do not look for another way to reach either. These requests are how a change is tried on the platform. A [scheduled job](#scheduled-jobs) is not tried there: the preview is an ephemeral app, so its schedules never fire, and these requests cannot reach `/_pneuma-space/`, where PneumaSpace delivers a job. What a job does is shown by the app's own tests, which import the job's file and call what it computes.
4. Submit: `node .appgov/appgov.mjs submit "<one sentence: what the user asked for>"`.
   **If your change deletes or rewrites data the app has already stored, in any kind of storage (`kv` entries, `db` rows or columns, `files`, objects), submit it with `--one-way "<what is lost>"`** and say in plain words what is lost, for example `--one-way "deletes the due date from every stored to-do list"`. The Host's rules read only SQL text and `pneuma-space.json`; for anything else they cannot see the loss, and your declaration is how the owner hears of it. A declared change waits for the owner, and going back past it needs the owner. Never leave the flag out to get a change through faster.
   The CLI sends the files of this working copy to the centre. In `personal` mode the Host refuses a change to a protected path or outside the paths above, runs `npm ci --ignore-scripts && npm test`, starts the change on PneumaSpace under a temporary name (the preview), and releases it only after it is approved. When `submit` answers, the CLI brings this working copy in line with the centre.
5. Read the answer:
   - `published`: the change is live at the printed address as a new version.
   - `rejected`: nothing was released. The reason and the tail of the failing output are printed; fix the files and submit again, or run `node .appgov/appgov.mjs discard` to put this working copy back to the active version.
   - `needs_approval`: the owner decides this change. It carries a risk the Host's rules do not approve on their own (with this edition's default rules: the app stops declaring `identity.required` or a storage capability, or new SQL drops or renames a table or column, drops an index, empties a table, or deletes every row), or you declared it one-way. Stop, show the user the printed disclosure and the preview's address, and let them decide. Your token cannot approve or deny; do not look for a way around that.
6. To go back: `node .appgov/appgov.mjs undo "<why>"` goes back one version each time. `undo --to <version> "<why>"` goes straight to an earlier one. Undo republishes that version's code; it does not roll back stored data, so keep schema changes additive. If going back would cross a change that dropped or rewrote stored data, undo refuses and says why. Then stop and show the user the message: only the owner can confirm that.

A request to change the app is finished only when `submit` has answered. Files you edited and did not submit are not live, and nobody else sees them: they are only in this working copy.

Once live, PneumaSpace stops the app's container after a few minutes without requests, and it then shows as asleep; the next request starts it again, with its data, in a few seconds. That is normal: do not add anything to keep it awake. The deployment runs only a few apps awake at once (two on PneumaSpace's default quotas), and an app kept awake takes one of them.

If `submit` says this working copy is behind (someone else released a version since it was last brought up to date), run `node .appgov/appgov.mjs fetch` and make the change again; `fetch` refuses while you have edits it would overwrite.

`.appgov/centre.json` holds the centre's address and the token this copy uses. It is never part of a version and is never sent to the centre with your files. Do not print it, copy it into another file, or commit it; `.gitignore` keeps it out of git. If the CLI cannot reach the centre, it says which address it tried; ask the user, do not start anything yourself.

What acts as the owner is the user's to run, in their own terminal: `approve`, `deny`, `undo --accept-one-way`, `login`, `token`, `container stop`, and any command with `--owner`. Never run them, never read the owner's files under `~/.appgov/`, and never send the centre anything but this copy's token through the CLI. Everything you run goes with that token and is recorded as yours.

## Notes for the next agent

Add a line here when you learn something the next agent needs (a data-model decision, a constraint the user stated). The next agent may be a different product on a different machine; this file and `.pneuma-framework/history.jsonl` are all it gets.
