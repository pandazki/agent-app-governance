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
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const SOCKET = '/run/appgov/supervisor.sock';
const WORK = '/work';
// Installs kept for reuse (see `reusableInstall`): root's only, so no test run can change one.
const INSTALLS = '/var/cache/appgov/installs';
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

/**
 * The parts of `a && b && c` when each is a plain command that leaves no shell state behind (no cd, export and the
 * like), so that running them one after another, stopping at the first that fails, is what `sh -c` would do. Each
 * part is then timed on its own. Anything else runs as one command.
 */
const STATEFUL = new Set(['cd', 'export', 'set', 'unset', 'source', '.', 'alias', 'umask', 'eval', 'exec', 'pushd', 'popd']);
function commandParts(command) {
  const parts = command.split(' && ').map((part) => part.trim());
  const plain = parts.every((part) => /^[\w@%+=:,./"'*-]+( +[\w@%+=:,./"'*-]+)*$/.test(part) && !STATEFUL.has(part.split(' ')[0]));
  return parts.length > 1 && plain ? parts : [command];
}

/** Run one shell command as `tests` in `cwd`; its whole process group is killed at the deadline or when it ends. */
function runAsTests(command, cwd, env, deadline, keep) {
  return new Promise((resolve) => {
    const began = Date.now();
    const child = spawn('setpriv', ['--reuid=tests', '--regid=tests', '--clear-groups', '--', 'sh', '-c', command], { cwd, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }, Math.max(1, deadline - Date.now()));
    child.on('close', (code) => {
      clearTimeout(timer);
      // Anything the command left running in its group goes too.
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      resolve({ code: timedOut ? 124 : (code ?? 1), timedOut, ms: Date.now() - began });
    });
  });
}

/**
 * `npm ci --ignore-scripts` installs exactly what package-lock.json names, checked against its integrity hashes,
 * and runs no package's scripts, so with the same package.json, lockfile and .npmrc, in the same image, it gives the
 * same node_modules. That install is kept, taken right after it succeeded and before any test ran, and copied
 * into the next run with the same inputs instead of installing again. Any other install command runs every time.
 * The key of the install `part` would make in `app`, or null.
 */
function reusableInstall(part, app) {
  if (part !== 'npm ci --ignore-scripts') return null;
  const hash = createHash('sha256').update(part);
  for (const file of ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', '.npmrc']) {
    const path = join(app, file);
    hash.update(`\0${file}\0`).update(existsSync(path) ? readFileSync(path) : 'absent');
  }
  return hash.digest('hex');
}

/** Copy `source` into a fresh directory owned by `tests`, run `command` there as `tests`, and clean up. */
async function runTests({ source, command, report, timeout_ms }) {
  const began = Date.now();
  const id = randomBytes(6).toString('hex');
  const work = join(WORK, id);
  const app = join(work, 'app');
  const reportFile = join(work, 'report', 'junit.xml');
  mkdirSync(join(work, 'report'), { recursive: true, mode: 0o700 });
  const copied = spawnSync('cp', ['-a', `${source}/.`, app], { encoding: 'utf8' });
  if (copied.status !== 0) {
    rmSync(work, { recursive: true, force: true });
    return { code: 1, output: `could not copy the tree to test: ${copied.stderr}` };
  }
  mkdirSync(join(work, 'tmp'), { recursive: true });
  spawnSync('chown', ['-R', `${TESTS.uid}:${TESTS.gid}`, work]);
  const copy_ms = Date.now() - began;
  const env = { PATH, HOME: '/home/tests', TMPDIR: join(work, 'tmp'), LANG: 'C.UTF-8', CI: '1', ...(report ? { NODE_OPTIONS: junitOptions(reportFile) } : {}) };
  let output = '';
  const keep = (chunk) => {
    output += chunk;
    if (output.length > 400_000) output = output.slice(-200_000);
  };
  const deadline = Date.now() + (timeout_ms ?? 600_000);
  const steps = [];
  let code = 0;
  let timedOut = false;
  for (const part of commandParts(command)) {
    const key = reusableInstall(part, app);
    const kept = key && join(INSTALLS, key);
    if (kept && existsSync(join(kept, 'done'))) {
      const reusedAt = Date.now();
      rmSync(join(app, 'node_modules'), { recursive: true, force: true });
      const copied = existsSync(join(kept, 'node_modules')) ? spawnSync('cp', ['-a', join(kept, 'node_modules'), join(app, 'node_modules')]) : { status: 0 };
      spawnSync('chown', ['-R', `${TESTS.uid}:${TESTS.gid}`, app]);
      if (copied.status === 0) {
        keep(`[appgov] ${part}: reused the install an earlier run made from this same package.json, lockfile and .npmrc\n`);
        steps.push({ command: `${part} (reused)`, ms: Date.now() - reusedAt, code: 0 });
        continue;
      }
    }
    const run = await runAsTests(part, app, env, deadline, keep);
    steps.push({ command: part, ms: run.ms, code: run.code });
    code = run.code;
    timedOut = run.timedOut;
    if (code !== 0) break;
    if (kept) {
      // Kept as it is now, before any test has run in this tree.
      try {
        rmSync(kept, { recursive: true, force: true });
        mkdirSync(kept, { recursive: true, mode: 0o700 });
        const saved = existsSync(join(app, 'node_modules')) ? spawnSync('cp', ['-a', join(app, 'node_modules'), join(kept, 'node_modules')]) : { status: 0 };
        spawnSync('chown', ['-R', '0:0', kept]);
        if (saved.status === 0) writeFileSync(join(kept, 'done'), '');
      } catch {}
    }
  }
  const result = { code, output: timedOut ? `${output}\n[timed out]` : output, ran_in: app, copy_ms, steps };
  if (report && existsSync(reportFile)) result.report = readFileSync(reportFile, 'utf8');
  rmSync(work, { recursive: true, force: true });
  return result;
}

mkdirSync(INSTALLS, { recursive: true, mode: 0o700 });
chmodSync('/var/cache/appgov', 0o700);
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
