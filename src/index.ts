import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { userCount } from './db/users.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp({ config });

  await app.listen({ host: config.host, port: config.port });
  app.log.info({ publicUrl: config.publicUrl, dataDir: config.dataDir }, 'Syncy is listening');

  if (userCount(app.db) === 0 && config.configuredUser === null) {
    app.log.warn(
      'No users exist yet. Set SYNCY_EMAIL and SYNCY_PASSWORD, or call POST /v1/setup to create the administrator.',
    );
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'Shutting down');
    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'Graceful shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
