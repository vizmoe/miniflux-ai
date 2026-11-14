import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, chmod, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const exec = promisify(execFile);
const image = process.argv[2] ?? 'miniflux-ai:local';
const name = `miniflux-ai-smoke-${randomBytes(6).toString('hex')}`;
const root = await mkdtemp(join(tmpdir(), 'miniflux-ai-container-'));
const docker = (...args) =>
  exec('docker', args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
let created = false;
try {
  await chmod(root, 0o755);
  await writeFile(
    join(root, 'config.yaml'),
    `miniflux:\n  base_url: http://127.0.0.1:9\n  api_key: smoke-test\n  request_timeout_ms: 100\nserver:\n  admin_token: ${randomBytes(32).toString('hex')}\ningestion:\n  webhook:\n    enabled: false\nruntime:\n  allow_insecure_http: true\n  shutdown_grace_period: 1s\n`,
    { mode: 0o644 },
  );
  await docker(
    'create',
    '--name',
    name,
    '--network',
    'none',
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--mount',
    'type=volume,destination=/app/data',
    '--mount',
    `type=bind,source=${root},target=/app/config,readonly`,
    image,
  );
  created = true;
  await docker('start', name);
  const probe = `
    import assert from 'node:assert/strict';
    import {readFile,writeFile} from 'node:fs/promises';
    import {setTimeout as delay} from 'node:timers/promises';
    import {parse} from 'yaml';
    assert.notEqual(process.getuid(), 0);
    let healthy = false;
    for (let attempt=0; attempt<100; attempt++) {
      try { if ((await fetch('http://127.0.0.1:8080/healthz',{signal:AbortSignal.timeout(500)})).ok) {healthy=true; break;} } catch {}
      await delay(100);
    }
    assert.ok(healthy, 'application did not become healthy');
    assert.equal((await fetch('http://127.0.0.1:8080/readyz')).status, 503);
    assert.equal((await fetch('http://127.0.0.1:8080/admin/config')).status, 401);
    for (const path of ['/console/','/console/app.js','/console/app.css']) assert.equal((await fetch('http://127.0.0.1:8080'+path)).status, 200);
    const config=parse(await readFile('/app/config/config.yaml','utf8'));
    const login=await fetch('http://127.0.0.1:8080/auth/session',{method:'POST',headers:{origin:'http://127.0.0.1:8080','content-type':'application/json'},body:JSON.stringify({token:config.server.admin_token})});
    assert.equal(login.status, 201);
    const mainMap=JSON.parse(await readFile('/app/dist/main.js.map','utf8'));
    assert.ok(mainMap.sourcesContent.every(source=>typeof source==='string' && source.length>0));
    const adminMap=JSON.parse(await readFile('/app/dist/admin/app.js.map','utf8'));
    assert.ok(adminMap.sourcesContent.some(source=>source.includes('class ScopeEditor')));
    await writeFile('/app/data/smoke-persistence','retained');
    console.log('Non-root startup, SQLite, assets, authentication, health, and embedded sources passed.');
  `;
  console.log(
    (
      await docker('exec', name, 'node', '--input-type=module', '-e', probe)
    ).stdout.trim(),
  );
  await docker(
    'exec',
    name,
    'node',
    'dist/healthcheck.js',
    '--config',
    '/app/config/config.yaml',
  );
  await docker('stop', '--time', '5', name);
  const state = JSON.parse(
    (await docker('inspect', '--format', '{{json .State}}', name)).stdout,
  );
  assert.equal(state.ExitCode, 0, 'application did not stop cleanly');
  await docker('start', name);
  console.log(
    (
      await docker(
        'exec',
        name,
        'node',
        '--input-type=module',
        '-e',
        `if (await (await import('node:fs/promises')).readFile('/app/data/smoke-persistence','utf8') !== 'retained') throw new Error('volume was not retained');` +
          probe,
      )
    ).stdout.trim(),
  );
  console.log(
    `Container smoke test passed: ${image}; volume survived restart.`,
  );
} catch (error) {
  if (created)
    await docker('logs', name).then(
      ({ stdout, stderr }) => console.error(stdout + stderr),
      () => {},
    );
  throw error;
} finally {
  if (created) await docker('rm', '--force', '--volumes', name);
  await rm(root, { recursive: true, force: true });
}
