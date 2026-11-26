# This app is governed: read this part first

This directory is a published app with a recorded history. Every version and the history are in `.pneuma-framework/`, which pneuma-framework writes; the CLI, the host's address and the changes waiting for a decision are in `.appgov/`, which the host writes. Any coding agent can pick it up; the rules in this part are the whole protocol.

The part after this one, "PneumaSpace app template", describes the platform, the manifest and the SDK. Use it for writing code. It also explains publishing with `appctl`: **do not do that here.** An app here goes live only through this CLI's `create` and `submit`. Do not publish, deploy or host it with any other tool, skill or service your environment offers, and do not create accounts or projects elsewhere for it.

## Changing this app (read this before the first edit)

1. See where things stand: `node .appgov/appgov.mjs status` and `node .appgov/appgov.mjs history`. `status` shows the active version, the address, uncommitted files and anything waiting for the owner. It also says which mode the host runs in and what `submit` does there. `history` shows what was asked for, what changed and what was guaranteed for each attempt, oldest first. To see every app this host manages, with its version, address, last change and anything waiting for the owner, run `node .appgov/appgov.mjs list`.
2. Edit files in place. You may change `src/`, `public/app/`, `pneuma-space.json`, `package.json`, `package-lock.json` and this file. `sdk/`, `ui/`, `public/ui.css`, `public/ui.js`, `appgov.scaffold.json` and `CLAUDE.md` are protected. Put your own styles and browser scripts under `public/app/`. `appgov.scaffold.json` is the machine-readable form of these boundaries.
3. Add a test for every change in behaviour, under `src/` in a file named `*.test.ts`, and run `npm test` before you submit. "Writing a test" below shows how.
   For each route you add or change, also add a request to `src/preview.json` (create it if the app has none), and keep the requests already there answering. `submit` makes them on the preview, in order, signed in as the owner, on storage that starts empty, so one request can store something and a later one read it back:
   ```json
   {"requests": [
     {"method": "POST", "path": "/api/items", "body": {"title": "Dune"}, "expect": {"status": 201}},
     {"path": "/api/items", "expect": {"status": 200, "contains": "Dune"}}
   ]}
   ```
   `method` is GET (the default), POST, PUT, PATCH or DELETE; `path` starts with one `/` and stays inside the app; `body` is JSON, never on a GET; `expect` needs `status` and may give `contains`, text the reply must include. No other fields; at most 20 requests, each answered within 20 s. A file that is not valid is rejected as `invalid_preview_requests`, saying what is wrong. A reply that is not as expected rejects the change as `preview_requests_failed`, and for each failing request the answer shows what was sent, what was expected and what the preview answered: fix the app, or the request if it expects the wrong thing. Do not try to reach the live app or the preview any other way; these requests are how a change is tried on the platform.
4. Submit: `node .appgov/appgov.mjs submit "<one sentence: what the user asked for>"`.
   **If your change deletes or rewrites data the app has already stored, in any kind of storage (database rows or columns, key-value entries, files, objects), submit it with `--one-way "<what is lost>"`** and say in plain words what is lost, for example `--one-way "deletes the due date from every stored to-do list"`. The host's rules read only SQL text and `pneuma-space.json`; for anything else they cannot see the loss, and your declaration is how the owner hears of it. A declared change waits for the owner in `personal` and `review-all`, and going back past it needs the owner in every mode. Never leave the flag out to get a change through faster.
   What the host does next depends on its mode, which `status` names:
   - `record`: it records your working tree as the next version and publishes it. Nothing checks or approves it, and the boundaries above are not enforced.
   - `personal` or `review-all`: it copies your working tree, refuses a change to a protected path or outside the paths above, runs `npm ci --ignore-scripts && npm test`, starts the draft on PneumaSpace under a temporary name (the preview) unless the host runs without previews, and releases it only after it is approved.
5. Read the answer:
   - `published`: the change is live at the printed address as a new version.
   - `rejected`: nothing was released. The reason and the tail of the failing output are printed; fix the working tree and submit again, or run `node .appgov/appgov.mjs discard` to put the working tree back to the active version.
   - `needs_approval`: the owner decides this change. In `personal` mode it carries a risk the host's rules do not approve on their own (with the default rules: visitors no longer have to sign in, or new SQL drops or renames a table or column, drops an index, empties a table, or deletes every row), or you declared it one-way. In `review-all` mode every change waits. Stop, show the user the printed disclosure and the preview's address, and let them decide: on the host's page, opened from the owner link the host printed for them, or with `approve` or `deny` in their own terminal. Never run `approve` or `deny` yourself.
   - `recorded ... but it did not go live` (record mode only): the version is in the history but is not live, and the command exits non-zero. The printed address line says what the address serves now; if it says the address could not be put back, nobody knows what it serves until the next release or undo answers. Tell the user. Then fix the cause and submit again (with no new edits, the same version goes out as it is), or undo.
6. To go back: `node .appgov/appgov.mjs undo "<why>"` goes back one version each time (v5, then v4, then v3). `undo --to <version> "<why>"` goes straight to an earlier one. Undo republishes that version's code. It does not roll back stored data, so keep schema changes additive. If going back would cross a change that dropped or rewrote stored data, undo refuses and says why, also when the host can put that data back (that would throw away what was stored since). Then stop and show the user the message. Only the owner can confirm going back past such a change, on the host's page or in their terminal.

A request to change the app is finished only when `submit` has answered. Files you edited and did not submit are not live; the next agent finds them listed as uncommitted and cannot tell whether they were meant.

`npm test` opens a port on 127.0.0.1 and `submit` calls the host. The CLI finds the host at the address the host recorded in `.appgov/host.json`; `--host <url>` or `APPGOV_HOST` overrides it. If you run in a sandbox that blocks either connection, ask for permission to run that command outside it; do not skip the step. If `status` cannot reach the host, the message names the address it tried and where that address came from. The host may be running on another address, or not running: ask the user for its address rather than starting anything yourself, then pass `--host <url>`.

## Writing a test

`npm test` runs the SDK's own tests and yours (`node --test '**/*.test.ts'`; an app made from an earlier template runs `node --test 'sdk/*.test.ts' 'src/**/*.test.ts'`). If the `test` script in `package.json` names neither `src/` nor `**/`, add `'src/**/*.test.ts'` to it. Test files are not published. When `src/app.ts` exports the handler, the template's part below shows a test that serves it on a free port. Otherwise, the smallest test that checks the app through a real request starts `src/server.ts` on a free port and asks it for a page:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';

test('GET / answers with the home page', async (t) => {
  // Find a free port, then start the app on it, the way the platform starts it.
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as AddressInfo).port;
  probe.close();
  const app = spawn(process.execPath, ['src/server.ts'], { env: { ...process.env, PNEUMA_SPACE_PORT: String(port) }, stdio: 'inherit' });
  t.after(() => app.kill());

  // The app needs a moment before it listens.
  let res: Response | undefined;
  for (let attempt = 0; !res && attempt < 50; attempt++) {
    res = await fetch(`http://127.0.0.1:${port}/`).catch(() => undefined);
    if (!res) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(res, 'the app did not answer');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<html/i);
});
```

Change the path, the method and the assertions to what you changed. Files under `public/` are served by the platform, not by `src/server.ts`, so a request in this test does not reach them; put the logic of a browser script in a module that a test can import. The host runs `npm test` again and records how many of the tests that ran are the app's own. When a change touches `src/` or `public/app/` and none of them ran, `submit` says so in one line.

## Notes for the next agent

Add a line here when you learn something the next agent needs (a data-model decision, a constraint the user stated). The next agent may be a different product; this file and `.pneuma-framework/history.jsonl` are all it gets.
