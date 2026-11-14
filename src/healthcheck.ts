import { isIP } from 'node:net';
import { argumentsOf } from './config/cli.js';
import { YamlConfiguration } from './config/store.js';
try {
  const { config } = new YamlConfiguration(argumentsOf().path).read();
  const bind = config.server.bind_address;
  const loopback: Record<string, string> = {
    '0.0.0.0': '127.0.0.1',
    '::': '::1',
  };
  const host = loopback[bind] ?? bind;
  const authority = isIP(host) === 6 ? `[${host}]` : host;
  const response = await fetch(
    `http://${authority}:${config.server.port}/healthz`,
    { signal: AbortSignal.timeout(4000) },
  );
  process.exitCode = response.ok ? 0 : 1;
} catch {
  process.exitCode = 1;
}
