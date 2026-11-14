import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config/index.js';
import {
  MINIFLUX_SUPPORTED_VERSION,
  MINIFLUX_VERSION_PROBE_TTL,
} from '../src/config/constants.js';
import { Database } from '../src/db/database.js';
import { Repository } from '../src/db/repository.js';
import { BindingController } from '../src/miniflux/binding.js';
import { MinifluxClient } from '../src/miniflux/client.js';
import { WorkError } from '../src/obs/errors.js';

const config = parseConfig(
  'miniflux:\n  base_url: https://miniflux.example.test\n  api_key: binding-test-api-key\nserver:\n  admin_token: binding-test-admin-token\ningestion:\n  webhook:\n    enabled: false\n',
);
const fixtures: { root: string; db: Database; binding: BindingController }[] =
  [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'miniflux-ai-binding-'));
  const db = new Database(root);
  const client = new MinifluxClient(config.miniflux);
  const version = vi
    .spyOn(client, 'version')
    .mockResolvedValue(MINIFLUX_SUPPORTED_VERSION);
  vi.spyOn(client, 'me').mockResolvedValue(1);
  const recovered = vi.fn();
  const binding = new BindingController(
    new Repository(db),
    client,
    config.miniflux.base_url,
    recovered,
  );
  fixtures.push({ root, db, binding });
  return { binding, version, recovered };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const { root, db, binding } of fixtures.splice(0)) {
    binding.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(['unsupported version', 'network failure'])(
  'closes admission after a verified account encounters %s and recovers automatically',
  async (failure) => {
    const { binding, version, recovered } = setup();
    expect((await binding.check()).ready).toBe(true);
    expect(binding.open).toBe(true);
    await vi.advanceTimersByTimeAsync(MINIFLUX_VERSION_PROBE_TTL);
    if (failure === 'unsupported version')
      version.mockResolvedValueOnce('99.0.0');
    else
      version.mockRejectedValueOnce(
        new WorkError('miniflux_network', 'network', true),
      );
    const status = await binding.check();
    expect(status.ready).toBe(false);
    expect(binding.open).toBe(false);
    expect(() => binding.requireOpen()).toThrow(status.reason!);
    expect(recovered).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MINIFLUX_VERSION_PROBE_TTL - 1);
    expect(version).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(version).toHaveBeenCalledTimes(3);
    expect(binding.open).toBe(true);
    expect(recovered).toHaveBeenCalledTimes(2);
  },
);

it('cancels compatibility recovery when the service stops', async () => {
  const { binding, version, recovered } = setup();
  await binding.check();
  await vi.advanceTimersByTimeAsync(MINIFLUX_VERSION_PROBE_TTL);
  version.mockResolvedValueOnce('99.0.0');
  await binding.check();
  binding.stop();
  await vi.advanceTimersByTimeAsync(MINIFLUX_VERSION_PROBE_TTL);
  expect(binding.open).toBe(false);
  expect(version).toHaveBeenCalledTimes(2);
  expect(recovered).toHaveBeenCalledTimes(1);
});
