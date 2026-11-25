// The container's first process, as root. It does two things and nothing else:
//
//   1. Starts the Host (cloudflare/src/serve.ts under Bun) as the unix user `host`, with the environment the
//      Durable Object passed to the container, and exits when the Host exits, so the container ends with it.
//   2. Runs an app's tests for the Host, as the unix user `tests`, on a unix socket that only `host` may open.
//      The tests are code an agent wrote. As `tests` they cannot read the Host's files (/data, /home/host are
//      mode 0700) or its environment (another user's /proc/<pid>/environ), and they get a clean environment.
//
// This is a second user in the same container, not a sandbox: the tests share the kernel, the network (with
// Internet access) and the disk with the Host. The README says so.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const SOCKET = '/run/appgov/supervisor.sock';
const WORK = '/work';
const EDITION = '/opt/appgov/cloudflare';
const uid = (name) => Number(spawnSync('id', ['-u', name], { encoding: 'utf8' }).stdout.trim());
const gid = (name) => Number(spawnSync('id', ['-g', name], { encoding: 'utf8' }).stdout.trim());
const HOST = { uid: uid('host'), gid: gid('host') };
const TESTS = { uid: uid('tests'), gid: gid('tests') };
const PATH = '/usr/local/bin:/usr/bin:/bin';
const log = (line) => console.log(`[supervisor] ${line}`);

// --- 1. the Host ------------------------------------------------------------------------------------------
const host = spawn('setpriv', ['--reuid=host', '--regid=host', '--init-groups', '--', 'bun', 'run', join(EDITION, 'src/serve.ts')], {
  cwd: EDITION,
  stdio: 'inherit',
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('APPGOV_'))), PATH, HOME: '/home/host', TMPDIR: '/tmp', LANG: 'C.UTF-8' },
});
host.on('exit', (code, signal) => {
  log(`the Host exited (${signal ?? code}); the container ends with it`);
  process.exit(code ?? 1);
});
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => host.kill(sig));

// --- 2. the tests -----------------------------------------------------------------------------------------
function junitOptions(file) {
  return ['--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=junit', `--test-reporter-destination=${file}`].join(' ');
}

/** Copy `source` into a fresh directory owned by `tests`, run `command` there as `tests`, and clean up. */
function runTests({ source, command, report, timeout_ms }) {
  return new Promise((resolve) => {
    const id = randomBytes(6).toString('hex');
    const work = join(WORK, id);
    const app = join(work, 'app');
    const reportFile = join(work, 'report', 'junit.xml');
    mkdirSync(join(work, 'report'), { recursive: true, mode: 0o700 });
    const copied = spawnSync('cp', ['-a', `${source}/.`, app], { encoding: 'utf8' });
    if (copied.status !== 0) {
      rmSync(work, { recursive: true, force: true });
      return resolve({ code: 1, output: `could not copy the tree to test: ${copied.stderr}` });
    }
    mkdirSync(join(work, 'tmp'), { recursive: true });
    spawnSync('chown', ['-R', `${TESTS.uid}:${TESTS.gid}`, work]);
    const child = spawn('setpriv', ['--reuid=tests', '--regid=tests', '--clear-groups', '--', 'sh', '-c', command], {
      cwd: app,
      detached: true,
      env: { PATH, HOME: '/home/tests', TMPDIR: join(work, 'tmp'), LANG: 'C.UTF-8', CI: '1', ...(report ? { NODE_OPTIONS: junitOptions(reportFile) } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    const keep = (chunk) => {
      output += chunk;
      if (output.length > 400_000) output = output.slice(-200_000);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }, timeout_ms ?? 600_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      // Anything the tests left running in their group goes too.
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      const result = { code: timedOut ? 124 : (code ?? 1), output: timedOut ? `${output}\n[timed out]` : output, ran_in: app };
      if (report && existsSync(reportFile)) result.report = readFileSync(reportFile, 'utf8');
      rmSync(work, { recursive: true, force: true });
      resolve(result);
    });
  });
}

mkdirSync('/run/appgov', { recursive: true, mode: 0o755 });
rmSync(SOCKET, { force: true });
const server = createServer((req, res) => {
  const reply = (status, value) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
  if (req.method !== 'POST' || req.url !== '/run') return reply(404, { error: 'not found' });
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', async () => {
    let body;
    try { body = JSON.parse(raw); } catch { return reply(400, { error: 'body must be JSON' }); }
    // The Host checks a private copy of each draft, which it makes under /tmp (appgov-check-*).
    const clean = typeof body.source === 'string' && /^\/tmp\/appgov-[\w-]+$/.test(body.source);
    if (!clean || typeof body.command !== 'string') return reply(400, { error: 'source (a directory /tmp/appgov-*) and command are required' });
    reply(200, await runTests(body));
  });
});
server.listen(SOCKET, () => {
  chownSync(SOCKET, HOST.uid, HOST.gid);
  chmodSync(SOCKET, 0o600);
  log(`the Host runs as host (${HOST.uid}); tests run as tests (${TESTS.uid}) on ${SOCKET}`);
});
