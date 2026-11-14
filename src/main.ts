import { ConfigurationError } from './config/index.js';
import { argumentsOf } from './config/cli.js';
import { YamlConfiguration } from './config/store.js';
import { createService } from './runtime/service.js';
import { buildServer } from './server/index.js';

async function main(): Promise<void> {
  const args = argumentsOf();
  const configuration = new YamlConfiguration(args.path);
  const config = configuration.read().config;
  const service = await createService(configuration),
    server = buildServer(service);
  try {
    await server.listen({
      port: config.server.port,
      host: config.server.bind_address,
    });
  } catch (error) {
    await service.stop();
    throw error;
  }
  service.start();
  service.logger.log('info', 'service_started');
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const closing = server.close();
    await service.stop();
    await closing;
    service.logger.log('info', 'service_stopped');
  };
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () => {
      void stop().catch(() => {
        process.exitCode = 1;
      });
    });
}
try {
  await main();
} catch (error) {
  process.stderr.write(
    JSON.stringify(
      error instanceof ConfigurationError
        ? { event: 'configuration_invalid', paths: error.paths }
        : { event: 'startup_failed' },
    ) + '\n',
  );
  process.exitCode = 1;
}
