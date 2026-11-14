import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import {
  auth,
  fixtureValues,
  entry,
  serviceFixture,
  config,
  temporaryRepository,
} from './helpers.js';
import { Database } from '../src/db/database.js';
import { createService } from '../src/runtime/service.js';

const fixtures: Awaited<ReturnType<typeof serviceFixture>>[] = [];
async function setup() {
  const f = await serviceFixture(
    'features:\n  summary:\n    min_source_units: 1',
  );
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
const origin = 'http://localhost:80';
const settings = {
  revision: 0,
  base_url: 'https://new-ai.test/v1',
  model: 'new-model',
  api_key: 'new-provider-secret',
  request_timeout_ms: 45000,
};

describe('browser administrator access', () => {
  it('keeps failure-map capacity from denying a valid login from another peer', async () => {
    const f = await setup();
    for (let i = 0; i < 1024; i++) {
      await f.app.inject({
        method: 'POST',
        url: '/auth/session',
        remoteAddress: `192.0.${Math.floor(i / 256)}.${i % 256}`,
        headers: { origin },
        payload: { token: 'wrong' },
      });
    }
    const login = await f.app.inject({
      method: 'POST',
      url: '/auth/session',
      remoteAddress: '198.51.100.10',
      headers: { origin },
      payload: { token: fixtureValues.admin_token },
    });
    expect(login.statusCode).toBe(201);
    const invalid = await f.app.inject({
      method: 'POST',
      url: '/auth/session',
      remoteAddress: '198.51.100.11',
      headers: { origin },
      payload: { token: 'wrong' },
    });
    expect(invalid.statusCode).toBe(401);
  });
  it('expires sessions, invalidates them on token rotation and sets Secure behind a configured HTTPS origin', async () => {
    const f = await setup();
    f.service.config.server.admin_origin = 'https://console.test';
    const login = await f.app.inject({
      method: 'POST',
      url: '/auth/session',
      headers: { origin: 'https://console.test' },
      payload: { token: fixtureValues.admin_token },
    });
    expect(login.statusCode).toBe(201);
    expect(login.headers['set-cookie']).toContain('; Secure');
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    f.service.config.server.admin_token = 'rotated-admin-token';
    expect(
      (await f.app.inject({ url: '/admin/model', headers: { cookie } }))
        .statusCode,
    ).toBe(401);
    f.service.config.server.admin_token = fixtureValues.admin_token;
    f.service.db.run('UPDATE admin_sessions SET expires_at=0');
    expect(
      (await f.app.inject({ url: '/admin/model', headers: { cookie } }))
        .statusCode,
    ).toBe(401);
  });
  it('exchanges a token for an opaque session, rejects CSRF and revokes logout', async () => {
    const f = await setup();
    expect((await f.app.inject('/admin/stats')).statusCode).toBe(401);
    const login = await f.app.inject({
      method: 'POST',
      url: '/auth/session',
      headers: { origin },
      payload: { token: fixtureValues.admin_token },
    });
    expect(login.statusCode).toBe(201);
    expect(login.body).not.toContain(fixtureValues.admin_token);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    expect(login.headers['set-cookie']).toContain('HttpOnly');
    expect(login.headers['set-cookie']).toContain('SameSite=Strict');
    expect(
      (await f.app.inject({ url: '/admin/stats', headers: { cookie } }))
        .statusCode,
    ).toBe(200);
    for (const headers of [
      { cookie },
      { cookie, origin: 'https://evil.test' },
    ]) {
      expect(
        (
          await f.app.inject({
            method: 'PUT',
            url: '/admin/model',
            headers,
            payload: settings,
          })
        ).statusCode,
      ).toBe(403);
    }
    expect(
      (
        await f.app.inject({
          method: 'DELETE',
          url: '/auth/session',
          headers: { cookie, origin },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (await f.app.inject({ url: '/admin/stats', headers: { cookie } }))
        .statusCode,
    ).toBe(401);
  });
  it('rejects foreign-origin login and rate limits incorrect tokens', async () => {
    const f = await setup();
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/auth/session',
          headers: { origin: 'https://evil.test' },
          payload: { token: fixtureValues.admin_token },
        })
      ).statusCode,
    ).toBe(403);
    for (let i = 0; i < 10; i++) {
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/auth/session',
            headers: { origin },
            payload: { token: 'wrong' },
          })
        ).statusCode,
      ).toBe(401);
    }
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/auth/session',
          headers: { origin },
          payload: { token: 'wrong' },
        })
      ).statusCode,
    ).toBe(429);
  });
});

describe('live model settings', () => {
  it('protects legacy WAL and SHM files before saving browser credentials after crash recovery', async () => {
    const f = temporaryRepository();
    f.db.close();
    const databaseURL = new URL('../src/db/database.ts', import.meta.url).href;
    const file = join(f.root, 'data/miniflux-ai.db');
    const program = `import {Database} from ${JSON.stringify(databaseURL)}; import {chmodSync} from 'node:fs'; const db = new Database(${JSON.stringify(f.root)}); db.run("INSERT INTO admin_sessions(token_hash,expires_at) VALUES('fixture-session',1)"); for (const suffix of ['', '-wal', '-shm']) chmodSync(${JSON.stringify(file)}+suffix,0o644); console.log('ready'); setInterval(()=>{},10000);`;
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', program],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    try {
      await Promise.race([
        once(child.stdout, 'data'),
        once(child, 'exit').then(() => {
          throw new Error('fixture_exited_before_ready');
        }),
      ]);
      child.kill('SIGKILL');
      await once(child, 'exit');
      const reopened = new Database(f.root);
      try {
        for (const suffix of ['', '-wal', '-shm'])
          expect(statSync(file + suffix).mode & 0o777).toBe(0o600);
        expect(reopened.get('SELECT token_hash FROM admin_sessions')).toEqual({
          token_hash: 'fixture-session',
        });
      } finally {
        reopened.close();
      }
    } finally {
      child.kill('SIGKILL');
      f.close();
    }
  });
  it('allows setup without providers and gates workers until YAML contains one', async () => {
    const f = await serviceFixture('ai:\n  providers: []\n');
    fixtures.push(f);
    expect(f.service.modelSettings.configured).toBe(false);
    expect(await f.service.ready()).toBe(false);
    f.service.queue.tick();
    await f.service.queue.idle();
    expect(f.service.repository.listTasks()).toHaveLength(0);
    const update = modelUpdate(f);
    expect(
      (
        await f.app.inject({
          method: 'PUT',
          url: '/admin/model',
          headers: auth,
          payload: update,
        })
      ).statusCode,
    ).toBe(200);
    expect(f.service.modelSettings.configured).toBe(true);
    expect(() =>
      config('ai:\n  providers: []\nserver:\n  admin_token: null\n'),
    ).toThrow();
  });
  it('saves YAML, redacts keys, and uses the new provider for already queued work after restart', async () => {
    const f = await setup();
    await f.prepare();
    f.upstream.entries.set(1, entry());
    await f.service.ingest.poll();
    const before = f.service.repository.listTasks({
      type: 'generate_artifacts',
    })[0]!;
    f.upstream.requests.length = 0;
    const update = modelUpdate(f);
    const result = await f.app.inject({
      method: 'PUT',
      url: '/admin/model',
      headers: auth,
      payload: update,
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      source: 'yaml',
      providers: [{ model: 'new-model', api_key_configured: true }],
    });
    expect(result.body).not.toContain(settings.api_key);
    expect(readFileSync(f.service.configuration.path, 'utf8')).toContain(
      'new-model',
    );
    expect(f.service.repository.task(before.id)?.payload).toEqual(
      before.payload,
    );
    await f.service.stop();
    const restarted = await createService(f.service.configuration, {
      root: f.root,
      fetch: f.upstream.fetch,
      logger: { log() {} },
    });
    try {
      await restarted.binding.check();
      restarted.queue.tick();
      await restarted.queue.idle();
      const call = f.upstream.requests.find((r) =>
        r.url.pathname.endsWith('/chat/completions'),
      )!;
      expect(call.url.origin).toBe('https://new-ai.test');
      expect(call.headers.get('authorization')).toBe(
        `Bearer ${settings.api_key}`,
      );
      expect(call.body).toMatchObject({ model: settings.model });
      expect(restarted.db.sqlite.serialize().includes(settings.api_key)).toBe(
        false,
      );
    } finally {
      await restarted.stop();
    }
    expect(
      (
        await f.app.inject({
          method: 'PUT',
          url: '/admin/model',
          headers: auth,
          payload: update,
        })
      ).statusCode,
    ).toBe(409);
    const cfg = await f.app.inject({ url: '/admin/config', headers: auth });
    expect(cfg.body).not.toContain(settings.api_key);
    expect(cfg.json()).toMatchObject({
      source: 'yaml',
      restart_required: false,
    });
  });
  it('requires explicit keys for new identities/endpoints and preserves keys only for the same identity and endpoint', async () => {
    const f = await setup();
    for (const bad of [
      { api_key: '' },
      { base_url: 'http://new-ai.test' },
      { base_url: 'https://secret@new-ai.test' },
      { base_url: 'https://new-ai.test/chat/completions' },
      { model: ' ' },
      { api_key: 'bad\r\nkey' },
      { base_url: fixtureValues.ai_url, id: 'different', api_key: '' },
      { id: 'bad/id' },
    ]) {
      const update = modelUpdate(f);
      Object.assign(update.providers[0]!, bad);
      const result = await f.app.inject({
        method: 'PUT',
        url: '/admin/model',
        headers: auth,
        payload: update,
      });
      expect(result.statusCode).toBe(400);
      expect(result.body).not.toContain(settings.api_key);
    }
    const update = modelUpdate(f);
    Object.assign(update.providers[0]!, {
      base_url: fixtureValues.ai_url,
      api_key: '',
    });
    expect(
      (
        await f.app.inject({
          method: 'PUT',
          url: '/admin/model',
          headers: auth,
          payload: update,
        })
      ).statusCode,
    ).toBe(200);
    expect(f.service.configuration.read().config.ai.providers[0]!.api_key).toBe(
      fixtureValues.ai_key,
    );
  });
  it('detects external edits, reads new routes, and reports startup-only changes as requiring restart', async () => {
    const f = await setup();
    const stale = modelUpdate(f);
    const path = f.service.configuration.path;
    writeFileSync(
      path,
      readFileSync(path, 'utf8')
        .replace('test-model', 'manual-model')
        .replace('port: 8080', 'port: 9090'),
    );
    expect(f.service.modelSettings.view()).toMatchObject({
      restart_required: true,
      providers: [{ model: 'manual-model' }],
    });
    expect(
      (
        await f.app.inject({
          method: 'PUT',
          url: '/admin/model',
          headers: auth,
          payload: stale,
        })
      ).statusCode,
    ).toBe(409);
    expect(f.service.config.server.port).toBe(8080);
    expect(f.service.configuration.read().config.server.port).toBe(9090);
  });
});
function modelUpdate(f: Awaited<ReturnType<typeof serviceFixture>>) {
  return {
    revision: f.service.modelSettings.view().revision,
    failover: { cooldown: '5m', failure_threshold: 2 },
    providers: [
      {
        id: 'primary',
        enabled: true,
        priority: 100,
        base_url: settings.base_url,
        model: settings.model,
        api_key: settings.api_key,
        request_timeout_ms: settings.request_timeout_ms,
      },
    ],
  };
}

describe('durable dashboard projections', () => {
  it('distinguishes ready Artifacts from Write-back and reports Feed and Entry states', async () => {
    const f = await setup();
    await f.prepare();
    const empty = await f.app.inject({ url: '/admin/stats', headers: auth });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({ entries: 0, render_pending: 0 });
    f.upstream.entries.set(1, entry());
    await f.service.ingest.poll();
    await f.drain();
    const stats = (
      await f.app.inject({ url: '/admin/stats', headers: auth })
    ).json();
    expect(stats).toMatchObject({
      entries: 1,
      render_pending: 0,
      features: { translation: { ready: 1 }, summary: { ready: 1 } },
    });
    expect(stats.feeds[0]).toMatchObject({ feed_id: 1, translation_ready: 1 });
    const entries = (
      await f.app.inject({
        url: '/admin/entries?state=ready&q=interesting',
        headers: auth,
      })
    ).json();
    expect(entries.entries[0]).toMatchObject({
      entry_id: 1,
      translation_state: 'ready',
      render_status: 'current',
    });
    expect(entries.entries[0]).not.toHaveProperty('content');
    f.service.db.run(
      'UPDATE entries SET render_generation=render_generation+1 WHERE entry_id=1',
    );
    expect(
      (await f.app.inject({ url: '/admin/stats', headers: auth })).json(),
    ).toMatchObject({
      render_pending: 1,
      rendered: 0,
      features: { translation: { ready: 1 } },
    });
    expect(
      (
        await f.app.inject({
          url: '/admin/entries?state=nonsense',
          headers: auth,
        })
      ).statusCode,
    ).toBe(400);
  });
});
