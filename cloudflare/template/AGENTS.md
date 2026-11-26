# PneumaSpace app on Cloudflare (contract pneuma-space.cf/1)

This part describes the platform the app runs on: PneumaSpace's Cloudflare plane. Use it for writing code. It started from PneumaSpace's Cloudflare starter app (MIT).

## What is here

- `pneuma-space.json`: the manifest. `contract` is `pneuma-space.cf/1`, `runtime` is `node`, `entry` is the server file inside `app/`, and `capabilities` declares the native services the app uses.
- `app/`: everything the platform runs, and nothing else. `app/server.mjs` is the data API; `app/public/` is the page shell (HTML, CSS, browser JavaScript, icons), which the platform serves from storage without starting Node. `app/space.mjs` calls the native services and runs the app's [scheduled jobs](#scheduled-jobs), one file each in `app/jobs/`.
- `tests/`: the app's tests, `*.test.mjs`, run by `npm test` with Node's test runner. They are not published.
- `PRODUCT.md` and `DESIGN.md`: what the starter app is for and how it looks.

## Rules of the platform

- The app is served at `/apps/<name>/` on the workspace's origin. Requests reach the server with that prefix removed and an `X-Forwarded-Prefix: /apps/<name>` header. Use relative URLs for pages, assets and API calls (`api/items`, not `/api/items`); a root path such as `/style.css` answers 404. `/apps/<name>/_pneuma-space/` is reserved.
- Every visitor signs in to the workspace first; PneumaSpace answers requests without a session with a sign-in page or 401. With `identity` declared, requests carry `X-Pneuma-Space-Subject`, `X-Pneuma-Space-Name` and `X-Pneuma-Space-Owner`. `"identity": { "required": true }` states that the app relies on knowing who the visitor is.
- Node 24, prebuilt JavaScript only, built-in modules. Bundle any dependency into `app/`. The package (manifest plus `app/`) is at most 4 MiB and 256 files.
- The server listens on `process.env.PNEUMA_SPACE_PORT`. Its files are temporary: the container stops after a few idle minutes and starts again on the next request, which takes seconds. Keep state in the native services, never on disk.
- The container has no public Internet egress. Native services answer at `http://pneuma-space.internal/broker`; `native(command)` in `app/space.mjs` does this:

```js
const response = await fetch('http://pneuma-space.internal/broker', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(command),
});
const value = await response.json();
if (!response.ok) throw Object.assign(new Error(value.error.message), { status: response.status });
```

## Native services

Declare each in `pneuma-space.json` under `capabilities` before using it: `kv` (JSON state), `db` (SQLite), `files` (small documents), `object` (large files), `rtc`. Each call is one command, posted as above. These are the commands and what each answers on success, as PneumaSpace's Cloudflare plane sends them:

| Command | Fields | Answer |
| --- | --- | --- |
| `kv.get` | `key` | `{key, value, revision, expiresAt}`, or `null` when there is no such key (or it expired) |
| `kv.put` | `key`, `value` (any JSON), `expected?`, `ttl?` (seconds, 1 to a year; without it the key has no expiry, even if it had one) | `{value, revision}` |
| `kv.delete` | `key`, `expected?` (a revision) | `{deleted: true}` or `{deleted: false}` |
| `kv.list` | `prefix?`, `cursor?` | `{items: [{key, value, revision, expiresAt}, ...], nextCursor?}`: the values are included, keys in order, expired ones left out |
| `kv.increment` | `key`, `amount` (an integer; required) | `{value, revision}`; a missing key counts from 0, a value that is not a number answers 409 `value_type`, and the expiry stays |
| `kv.publish` | `channel`, `value` | `{subscribers}`: how many live subscribers got it |
| `db.query` | `sql` (one statement), `params` (a list; required, `[]` when empty) | `{rows: [{<column>: <value>}, ...], columns: [...], rowsRead, rowsWritten}`, blobs as base64; more than 1000 rows or 256 KiB answers 413 `result_limit` |
| `db.batch` | `statements: [{sql, params}, ...]` (1 to 32, all or nothing) | `{results: [<one db.query answer per statement>]}` |
| `files.put` | `path`, `body` (base64, at most 64 KiB decoded), `expected?` | `{path, body, revision, bytes}` |
| `files.get` | `path` | `{path, body, revision, bytes}`, or `null` |
| `files.list` | `prefix?`, `cursor?` | `{items: [{path, body, revision, bytes}, ...], nextCursor?}`: the bodies are included, so a page may hold only two large files |
| `files.delete` | `path`, `expected?` (a revision) | `{deleted: true}` or `{deleted: false}` |
| `object.upload` | `key`, `bytes` (at most 100 MiB), `contentType` | `{id, url, headers, expiresAt}`: the browser PUTs the bytes to `url` with `headers` within 300 s |
| `object.complete` | `id` (from `object.upload`) | `{key, bytes, contentType, etag, uploadedAt}`, once the bytes are there; before that 409 `upload_missing`, and 409 `upload_metadata` when their size or type differs |
| `object.download` | `key` | `{id, url, headers, expiresAt}`: the browser GETs the bytes from `url` |
| `object.list` | `prefix?`, `cursor?` | `{items: [{key, bytes, contentType, etag, uploadedAt}, ...], nextCursor?}` |
| `object.delete` | `key` | `{deleted: true}` or `{deleted: false}` |
| `rtc.credentials` | none | `{iceServers: [{urls, username?, credential?}, ...], expiresAt}`, valid 600 s |

- `expected` compares and swaps: a number writes only while the revision is still that one, and on `kv.put` and `files.put` `null` writes only when nothing is there yet. A mismatch answers 409 with code `revision`: read again before retrying. One counter per app numbers the revisions of every key and file, so a key's revision grows, but not by one: compare it, never compute it.
- Times (`expiresAt`, `uploadedAt`) are milliseconds since the epoch.
- A list answers at most 100 items or 256 KiB at a time. While `nextCursor` is in the answer, send the same command again with `cursor: nextCursor` (and the same `prefix`) for the rest; the last page has none. A cursor from another listing answers 400 `cursor`.
- A `key` is 1 to 300 characters without control characters. A `path` and an object `key` are 1 to 300 characters, relative, without `\` and without empty, `.` or `..` parts (else 400 `path`).
- A refusal answers an HTTP status with `{"error": {"code", "message"}}`: 400 `input` (a field is wrong), 400 `command` (no such command), 400 `sql_statement` (a statement that fails, several statements, or `BEGIN` and the like), 403 `capability` (not declared in the manifest), 404 for an object or upload that is not there, 409 as above, 410 `upload_expired`, 413 `body_limit` (a command over 256 KiB), 413 `file_limit` or `result_limit`, 429 `storage_quota` (the app's storage is full). A 500 adds `requestId`.
- `db`: one statement per query, parameters for values, small results. Create tables with `CREATE TABLE IF NOT EXISTS`; never drop or rewrite existing columns.
- `static`: `{"dir": "public"}` names the page shell's directory inside `app/`. A GET for a file there is answered without starting Node, even while the app sleeps; a path ending in `/` serves that directory's `index.html`.
- `ws` has no broker command; the server subscribes to what `kv.publish` sends with a WebSocket to `ws://pneuma-space.internal/subscribe/<channel>`. See PneumaSpace's Cloudflare application contract. `cron` has none either: see [Scheduled jobs](#scheduled-jobs).

## Scheduled jobs

A job runs inside the app on a schedule, with no visitor. Declare it in `pneuma-space.json`, beside the other capabilities:

```json
"cron": { "triggers": { "digest": { "schedule": "0 6 * * *" } } }
```

Then write `app/jobs/digest.mjs`:

```js
import { native } from '../space.mjs';

// What the job computes, without the network, so that a test can import it and call it.
export function summarize(items) {
  return { entries: items.length, pinned: items.filter((item) => item.pinned).length };
}

export default async function ({ id, attempt, payload }) {
  const saved = await native({ type: 'kv.get', key: 'shelf:items' });
  await native({ type: 'kv.put', key: 'digest', value: summarize(saved?.value ?? []) });
}
```

- The schedule has five fields in UTC: minute, hour, day of the month, month and day of the week. A trigger without a schedule (`"digest": {}`) runs only when the PneumaSpace owner invokes it in PneumaSpace's console. At most 16 triggers; a name is lowercase letters, digits and hyphens, starting with a letter.
- `app/space.mjs` runs each delivery with the file of the same name. Every `.mjs` file directly in `app/jobs/` is a job; keep shared code elsewhere. A test in `tests/server.test.mjs` fails when a declared job has no file, or a file has no declaration.
- A run wakes the app if it sleeps. The job can use the app's stored data and the native services. It has no Internet access, so it cannot fetch anything from outside.
- PneumaSpace delivers each run at least once. `app/space.mjs` records a finished delivery in kv for a day, under `job:done:`, and does not run it again, so keep `kv` declared. A delivery that stopped partway arrives again, so write the job so that a second run does no harm: compute a result and overwrite it, as above, instead of appending. A job that throws is retried with growing delays, up to five attempts.
- An ephemeral app never runs its schedules.

## Testing

`npm test` runs `node --test "tests/**/*.test.mjs"`. The server talks to `pneuma-space.internal`, which does not exist on your machine, so a test that starts `app/server.mjs` can check routing, validation and errors, but a route that reads storage answers 500 there. Put logic you want to test in a module under `app/` that a test can import without the network. A job file is such a module: importing it runs nothing, so a test imports `summarize` from `../app/jobs/digest.mjs` and checks what it returns.
