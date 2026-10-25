import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { ensureConfiguredUser } from './auth/bootstrap.js';
import { type AuthContext, authenticate, requireAdmin } from './auth/middleware.js';
import { WsTicketStore } from './auth/tickets.js';
import { type Config, loadConfig, SERVER_NAME, SERVER_VERSION } from './config.js';
import { type Db, openDatabase } from './db/index.js';
import { pruneRefreshTokens } from './db/tokens.js';
import { userCount } from './db/users.js';
import { errorBody, registerErrorHandler } from './errors.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerBlobRoutes } from './routes/blobs.js';
import { registerDeviceRoutes } from './routes/devices.js';
import { registerSyncRoutes } from './routes/sync.js';
import { registerVaultRoutes } from './routes/vaults.js';
import { registerWsRoutes } from './routes/ws.js';
import { LocalBlobStore } from './services/blobStore.js';
import { WsHub } from './ws/hub.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    config: Config;
    blobs: LocalBlobStore;
    hub: WsHub;
    tickets: WsTicketStore;
    authenticate: typeof authenticate;
    requireAdmin: typeof requireAdmin;
  }

  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export interface BuildAppOptions {
  config?: Config;
  db?: Db;
  blobs?: LocalBlobStore;
  logger?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const db = options.db ?? openDatabase(config);
  const blobs = options.blobs ?? new LocalBlobStore(config.blobDir, config.maxBlobBytes);
  if (!options.blobs) await blobs.init();

  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: config.logLevel,
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'res.headers["set-cookie"]',
              ],
              censor: '[redacted]',
            },
          },
    trustProxy: config.trustProxy,
    bodyLimit: config.maxJsonBodyBytes,
    exposeHeadRoutes: false,
  });

  app.decorate('db', db);
  app.decorate('config', config);
  app.decorate('blobs', blobs);
  app.decorate('hub', new WsHub());
  app.decorate('tickets', new WsTicketStore());
  app.decorate('authenticate', authenticate);
  app.decorate('requireAdmin', requireAdmin);
  app.decorateRequest('auth', null);

  await app.register(helmet, { contentSecurityPolicy: false });
  if (config.corsOrigins.length > 0) {
    await app.register(cors, {
      origin: config.corsOrigins.includes('*') ? '*' : config.corsOrigins,
      credentials: false,
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    });
  }
  await app.register(rateLimit, {
    global: true,
    max: config.rateLimitMax,
    timeWindow: '1 minute',
    errorResponseBuilder: (_request, context) =>
      errorBody('RATE_LIMITED', `Rate limit exceeded. Retry in ${context.after}.`),
  });
  await app.register(websocket, {
    options: {
      maxPayload: 128 * 1024,
    },
  });

  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
    done(null, payload);
  });

  app.setErrorHandler(registerErrorHandler);
  app.setNotFoundHandler((_request, reply) => {
    return reply.status(404).send(errorBody('NOT_FOUND', 'Route not found'));
  });

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_request, reply) => {
    try {
      db.prepare('SELECT 1').get();
      return { ok: true };
    } catch {
      return reply.status(503).send({ ok: false });
    }
  });

  app.get('/', async () => ({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    api: `${config.publicUrl}/v1`,
    health: `${config.publicUrl}/healthz`,
  }));

  app.get('/v1/info', async () => {
    const count = userCount(db);
    return {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      setupRequired: count === 0 && config.configuredUser === null,
      registrationOpen: config.allowRegistration && count > 0,
      e2ee: true,
      maxBlobBytes: config.maxBlobBytes,
      realtime: true,
      apiVersion: 1,
    };
  });

  await registerAuthRoutes(app);
  await registerDeviceRoutes(app);
  await registerVaultRoutes(app);
  await registerSyncRoutes(app);
  await registerBlobRoutes(app);
  await registerAdminRoutes(app);
  await registerWsRoutes(app);

  const bootstrap = await ensureConfiguredUser(db, config);
  if (bootstrap?.created) {
    app.log.info({ email: config.configuredUser?.email }, 'Created configured user');
  } else if (bootstrap?.passwordUpdated) {
    app.log.info({ email: config.configuredUser?.email }, 'Updated configured user password');
  }

  const heartbeat = setInterval(() => {
    app.hub.heartbeat();
  }, 30_000);
  heartbeat.unref();

  const cleanup = setInterval(
    () => {
      app.tickets.prune();
      try {
        pruneRefreshTokens(db);
      } catch (error) {
        app.log.warn({ err: error }, 'Failed to prune refresh tokens');
      }
    },
    6 * 60 * 60_000,
  );
  cleanup.unref();

  app.addHook('onClose', async () => {
    clearInterval(heartbeat);
    clearInterval(cleanup);
    app.hub.closeAll();
    app.tickets.clear();
    if (!options.db) db.close();
  });

  return app;
}
