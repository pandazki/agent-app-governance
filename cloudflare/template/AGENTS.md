# PneumaSpace app on Cloudflare (contract pneuma-space.cf/1)

This part describes the platform the app runs on: PneumaSpace's Cloudflare plane. Use it for writing code. It started from PneumaSpace's Cloudflare starter app (MIT).

## What is here

- `pneuma-space.json`: the manifest. `contract` is `pneuma-space.cf/1`, `runtime` is `node`, `entry` is the server file inside `app/`, and `capabilities` declares the native services the app uses.
- `app/`: everything the platform runs, and nothing else. `app/server.mjs` is the data API; `app/public/` is the page shell (HTML, CSS, browser JavaScript, icons), which the platform serves from storage without starting Node.
- `tests/`: the app's tests, `*.test.mjs`, run by `npm test` with Node's test runner. They are not published.
- `PRODUCT.md` and `DESIGN.md`: what the starter app is for and how it looks.

## Rules of the platform

- The app is served at `/apps/<name>/` on the workspace's origin. Requests reach the server with that prefix removed and an `X-Forwarded-Prefix: /apps/<name>` header. Use relative URLs for pages, assets and API calls (`api/items`, not `/api/items`); a root path such as `/style.css` answers 404. `/apps/<name>/_pneuma-space/` is reserved.
- Every visitor signs in to the workspace first; PneumaSpace answers requests without a session with a sign-in page or 401. With `identity` declared, requests carry `X-Pneuma-Space-Subject`, `X-Pneuma-Space-Name` and `X-Pneuma-Space-Owner`. `"identity": { "required": true }` states that the app relies on knowing who the visitor is.
- Node 24, prebuilt JavaScript only, built-in modules. Bundle any dependency into `app/`. The package (manifest plus `app/`) is at most 4 MiB and 256 files.
- The server listens on `process.env.PNEUMA_SPACE_PORT`. Its files are temporary: the container stops after a few idle minutes and starts again on the next request, which takes seconds. Keep state in the native services, never on disk.
- The container has no public Internet egress. Native services answer at `http://pneuma-space.internal/broker`:

```js
const response = await fetch('http://pneuma-space.internal/broker', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(command),
});
const value = await response.json();
if (!response.ok) throw Object.assign(new Error(value.error.message), { status: response.status });
```

## Native services

Declare each in `pneuma-space.json` under `capabilities` before using it.

- `kv` (JSON state): `{type:'kv.get',key}` returns `{value,revision,expiresAt}` or null. `{type:'kv.put',key,value,expected}` returns a new revision; `expected: null` creates only, a number compares and swaps, and 409 means reload before retrying. `{type:'kv.delete',key,expected?}`, `{type:'kv.list',prefix?}`, `{type:'kv.increment',key,amount}`.
- `db` (SQLite): `{type:'db.query',sql,params:[]}` returns rows, columns and row counts; `{type:'db.batch',statements:[{sql,params:[]}]}` is atomic. One statement per query, parameters for values, small results. Create tables with `CREATE TABLE IF NOT EXISTS`; never drop or rewrite existing columns.
- `files` (small documents): `{type:'files.put',path,body,expected?}` stores base64 up to 64 KiB; `{type:'files.get',path}` reads it.
- `object` (large files): upload and download tickets; bytes go directly between the browser and storage.
- `static`: `{"dir": "public"}` names the page shell's directory inside `app/`. A GET for a file there is answered without starting Node, even while the app sleeps; a path ending in `/` serves that directory's `index.html`.
- `ws`, `cron` and `rtc` exist too; see PneumaSpace's Cloudflare application contract.

## Testing

`npm test` runs `node --test "tests/**/*.test.mjs"`. The server talks to `pneuma-space.internal`, which does not exist on your machine, so a test that starts `app/server.mjs` can check routing, validation and errors, but a route that reads storage answers 500 there. Put logic you want to test in a module under `app/` that a test can import without the network.
