import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';

const app = new URL('../app/', import.meta.url);

test('the page shell is in app/public, where the platform serves it without starting Node', async () => {
  const html = await readFile(new URL('public/index.html', app), 'utf8');
  assert.match(html, /<html/i);
  // The app lives under /apps/<name>/: its own files are asked for by relative URLs.
  assert.match(html, /href="style\.css"/);
  assert.match(html, /src="app\.js"/);
});

test('the server answers a path it does not know with 404', async (t) => {
  // A free port, then the server on it, as the platform starts it.
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  probe.close();
  const server = spawn(process.execPath, ['server.mjs'], { cwd: app, env: { ...process.env, PNEUMA_SPACE_PORT: String(port) }, stdio: 'inherit' });
  t.after(() => server.kill());

  let res;
  for (let attempt = 0; !res && attempt < 50; attempt++) {
    res = await fetch(`http://127.0.0.1:${port}/no-such-path`).catch(() => undefined);
    if (!res) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(res, 'the server did not answer');
  assert.equal(res.status, 404);
});
