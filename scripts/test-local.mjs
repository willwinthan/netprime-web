// Runs the actual Worker with disposable local D1, KV and R2. Never uses remote IDs.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const suite = process.argv[2] || 'smoke';
if (!['smoke', 'readiness', 'auth', 'outsource', 'business', 'learning', 'site', 'access', 'accounts', 'teaching', 'payments', 'coordination', 'partners'].includes(suite)) throw new Error('Unknown test suite');
const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'netprime-test-'));
const configPath = join(temp, 'wrangler.json');
const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(temp, 'logs'), CI: 'true' };
// Do not pass cloud credentials to the local harness.
for (const key of Object.keys(env)) {
  if (/^(CLOUDFLARE_|CF_)/.test(key)) delete env[key];
}
let worker;
let testProcess;
let workerOutput = '';
let interrupted = false;
const stop = () => {
  interrupted = true;
  worker?.kill('SIGTERM');
  testProcess?.kill('SIGTERM');
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

function run(args, stdio = 'pipe') {
  return spawn(process.execPath, args, { cwd: temp, env, stdio });
}

try {
  const config = JSON.parse(await readFile(resolve(root, 'backend/wrangler.local.jsonc'), 'utf8'));
  delete config.$schema;
  config.main = resolve(root, 'backend/src/index.ts');
  await writeFile(configPath, JSON.stringify(config));
  console.log('Preparing a disposable local database…');
  const setup = run([wrangler, 'd1', 'execute', 'netprime-test-db', '--config', configPath,
    '--local', '--persist-to', join(temp, 'state'), '--file', resolve(root, 'backend/schema.sql')]);
  let setupOutput = '';
  setup.stdout.on('data', chunk => { setupOutput += chunk; });
  setup.stderr.on('data', chunk => { setupOutput += chunk; });
  const [setupCode] = await once(setup, 'exit');
  if (setupCode !== 0) throw new Error(`Local database setup failed:\n${setupOutput}`);

  const reservation = createServer();
  await new Promise((resolvePort, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolvePort);
  });
  const port = reservation.address().port;
  await new Promise(resolveClose => reservation.close(resolveClose));
  const base = `http://127.0.0.1:${port}`;
  worker = run([wrangler, 'dev', '--config', configPath, '--local', '--ip', '127.0.0.1',
    '--port', String(port), '--inspector-port', '0', '--persist-to', join(temp, 'state')]);
  const collect = chunk => { workerOutput = (workerOutput + chunk).slice(-24000); };
  worker.stdout.on('data', collect);
  worker.stderr.on('data', collect);
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (interrupted || worker.exitCode !== null) throw new Error('Local Worker stopped before readiness');
    try {
      const res = await fetch(base, { signal: AbortSignal.timeout(1000) });
      if (res.ok && (await res.text()).includes('Netprime')) { ready = true; break; }
    } catch { /* Wait for local Worker startup. */ }
    await delay(250);
  }
  if (!ready) throw new Error('Local Worker did not become ready');
  console.log(`Running ${suite} tests against disposable local Worker ${base}`);
  testProcess = spawn(process.execPath, ['--test', '--test-concurrency=1',
    resolve(root, `tests/${suite}.test.mjs`)], {
    cwd: root, env: { ...env, NETPRIME_TEST_BASE: base }, stdio: 'inherit'
  });
  const [code] = await once(testProcess, 'exit');
  process.exitCode = code ?? 1;
} catch (error) {
  console.error(error.message);
  console.error(workerOutput);
  process.exitCode = 1;
} finally {
  if (worker && worker.exitCode === null) {
    const exited = once(worker, 'exit');
    worker.kill('SIGTERM');
    const forceKill = setTimeout(() => worker.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(forceKill);
  }
  await rm(temp, { recursive: true, force: true });
}
