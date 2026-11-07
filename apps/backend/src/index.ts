import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('backend');

async function main() {
  const config = loadConfig();
  const app = await createApp(config, log);
  await app.start();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { signal });
    const force = setTimeout(() => process.exit(1), 10_000).unref();
    try {
      await app.stop();
    } finally {
      clearTimeout(force);
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log.error('fatal', { err });
  process.exit(1);
});
