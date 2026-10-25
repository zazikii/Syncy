import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { signAccessToken } from '../auth/jwt.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { issueSession } from '../auth/sessions.js';
import { getDevice, touchDevice, upsertDevice } from '../db/devices.js';
import {
  revokeAllForUser,
  revokeFamily,
  revokeRefreshToken,
  rotateRefreshToken,
} from '../db/tokens.js';
import {
  bumpTokenVersion,
  createUser,
  findUserByEmail,
  findUserById,
  toPublicUser,
  type UserRow,
  updateUserDisplayName,
  updateUserPassword,
  userCount,
} from '../db/users.js';
import { conflict, forbidden, unauthorized } from '../errors.js';
import { safeEqual } from '../utils/secret.js';
import {
  changePasswordSchema,
  loginSchema,
  logoutSchema,
  refreshSchema,
  registerSchema,
  setupSchema,
  updateMeSchema,
} from './schemas.js';

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const dummyHash = await hashPassword(randomBytes(24).toString('base64url'));

  app.post('/v1/setup', async (request, reply) => {
    const body = setupSchema.parse(request.body);

    if (userCount(app.db) > 0) {
      throw forbidden('SETUP_COMPLETE', 'Setup has already been completed');
    }

    if (app.config.setupToken) {
      const headerToken = request.headers['x-setup-token'];
      const provided = body.setupToken ?? (typeof headerToken === 'string' ? headerToken : '');
      if (!provided || !safeEqual(provided, app.config.setupToken)) {
        throw forbidden('INVALID_SETUP_TOKEN', 'A valid setup token is required');
      }
    }

    const passwordHash = await hashPassword(body.password);
    const user = app.db.transaction(() => {
      if (userCount(app.db) > 0) {
        throw forbidden('SETUP_COMPLETE', 'Setup has already been completed');
      }
      return createUser(app.db, {
        email: body.email,
        passwordHash,
        displayName: body.name ?? null,
        isAdmin: true,
      });
    })();

    const device = upsertDevice(app.db, user.id, body.device);
    const session = await issueSession(app.db, app.config, user, device.id);
    return reply.status(201).send(session);
  });

  app.post('/v1/auth/register', async (request, reply) => {
    const body = registerSchema.parse(request.body);

    if (userCount(app.db) === 0) {
      throw forbidden('SETUP_REQUIRED', 'Create the first administrator with /v1/setup');
    }
    if (!app.config.allowRegistration) {
      throw forbidden('REGISTRATION_DISABLED', 'Self-service registration is disabled');
    }
    if (findUserByEmail(app.db, body.email)) {
      throw conflict('EMAIL_IN_USE', 'An account with this email already exists');
    }

    const passwordHash = await hashPassword(body.password);
    let user: UserRow;
    try {
      user = createUser(app.db, {
        email: body.email,
        passwordHash,
        displayName: body.name ?? null,
        isAdmin: false,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE')) {
        throw conflict('EMAIL_IN_USE', 'An account with this email already exists');
      }
      throw error;
    }

    const device = upsertDevice(app.db, user.id, body.device);
    const session = await issueSession(app.db, app.config, user, device.id);
    return reply.status(201).send(session);
  });

  app.post(
    '/v1/auth/login',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request) => {
      const body = loginSchema.parse(request.body);
      const user = findUserByEmail(app.db, body.email);

      if (!user) {
        await verifyPassword(body.password, dummyHash);
        throw unauthorized('INVALID_CREDENTIALS', 'Email or password is incorrect');
      }

      if (!(await verifyPassword(body.password, user.password_hash))) {
        throw unauthorized('INVALID_CREDENTIALS', 'Email or password is incorrect');
      }

      if (user.disabled === 1) {
        throw forbidden('ACCOUNT_DISABLED', 'This account is disabled');
      }

      const device = upsertDevice(app.db, user.id, body.device);
      return issueSession(app.db, app.config, user, device.id);
    },
  );

  app.post('/v1/auth/refresh', async (request) => {
    const body = refreshSchema.parse(request.body);
    const rotated = rotateRefreshToken(app.db, body.refreshToken, app.config.refreshTokenTtlDays);
    const user = findUserById(app.db, rotated.userId);

    if (!user || user.disabled === 1) {
      revokeFamily(app.db, rotated.issued.row.family_id);
      throw unauthorized('ACCOUNT_DISABLED', 'This account is no longer active');
    }
    if (rotated.deviceId && !getDevice(app.db, user.id, rotated.deviceId)) {
      revokeFamily(app.db, rotated.issued.row.family_id);
      throw unauthorized('DEVICE_REVOKED', 'This device has been removed');
    }

    touchDevice(app.db, user.id, rotated.deviceId);

    const access = await signAccessToken(app.config, user, rotated.deviceId);

    return {
      tokenType: 'Bearer',
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      expiresIn: access.expiresIn,
      refreshToken: rotated.issued.token,
      refreshTokenExpiresAt: rotated.issued.row.expires_at,
      deviceId: rotated.deviceId,
      user: toPublicUser(user),
    };
  });

  app.post('/v1/auth/logout', async (request, reply) => {
    const body = logoutSchema.parse(request.body);
    revokeRefreshToken(app.db, body.refreshToken);
    return reply.status(204).send();
  });

  app.post('/v1/auth/logout-all', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = request.auth!.user.id;
    revokeAllForUser(app.db, userId);
    bumpTokenVersion(app.db, userId);
    app.hub.dropUser(userId);
    return reply.status(204).send();
  });

  app.get('/v1/auth/me', { preHandler: app.authenticate }, async (request) => {
    return {
      user: toPublicUser(request.auth!.user),
      deviceId: request.auth!.deviceId,
    };
  });

  app.patch('/v1/auth/me', { preHandler: app.authenticate }, async (request) => {
    const body = updateMeSchema.parse(request.body);
    updateUserDisplayName(app.db, request.auth!.user.id, body.displayName);
    const user = findUserById(app.db, request.auth!.user.id)!;
    return { user: toPublicUser(user) };
  });

  app.post('/v1/auth/password', { preHandler: app.authenticate }, async (request, reply) => {
    const body = changePasswordSchema.parse(request.body);
    const user = findUserById(app.db, request.auth!.user.id)!;

    if (!(await verifyPassword(body.currentPassword, user.password_hash))) {
      throw unauthorized('INVALID_PASSWORD', 'Current password is incorrect');
    }

    const passwordHash = await hashPassword(body.newPassword);
    updateUserPassword(app.db, user.id, passwordHash);
    revokeAllForUser(app.db, user.id);
    bumpTokenVersion(app.db, user.id);
    app.hub.dropUser(user.id);
    return reply.status(204).send();
  });

  app.post('/v1/auth/ws-ticket', { preHandler: app.authenticate }, async (request) => {
    return app.tickets.create(request.auth!.user.id, request.auth!.deviceId);
  });
}
