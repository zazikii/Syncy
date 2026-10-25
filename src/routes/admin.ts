import type { FastifyInstance } from 'fastify';
import { SERVER_NAME, SERVER_VERSION } from '../config.js';
import {
  adminCount,
  findUserById,
  listUsers,
  toPublicUser,
  updateUserFlags,
  userCount,
} from '../db/users.js';
import { countVaults } from '../db/vaults.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { adminUserParams, adminUsersQuery, adminUserUpdateSchema } from './schemas.js';

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/admin/stats', { preHandler: [app.authenticate, app.requireAdmin] }, async () => {
    const blobs = await app.blobs.list();
    const storageBytes = blobs.reduce((total, blob) => total + blob.size, 0);
    const deviceRow = app.db.prepare('SELECT COUNT(*) AS count FROM devices').get() as {
      count: number;
    };

    return {
      server: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
      users: userCount(app.db),
      vaults: countVaults(app.db),
      devices: deviceRow.count,
      blobs: blobs.length,
      storageBytes,
      connectedSockets: app.hub.size,
    };
  });

  app.get(
    '/v1/admin/users',
    { preHandler: [app.authenticate, app.requireAdmin] },
    async (request) => {
      const query = adminUsersQuery.parse(request.query);
      const page = listUsers(app.db, query);
      return {
        users: page.users,
        total: page.total,
        limit: query.limit,
        offset: query.offset,
      };
    },
  );

  app.patch(
    '/v1/admin/users/:userId',
    { preHandler: [app.authenticate, app.requireAdmin] },
    async (request) => {
      const { userId } = adminUserParams.parse(request.params);
      const body = adminUserUpdateSchema.parse(request.body);
      const user = findUserById(app.db, userId);
      if (!user) throw notFound('USER_NOT_FOUND', 'User not found');

      if (user.id === request.auth!.user.id) {
        if (body.disabled === true) {
          throw conflict('CANNOT_DISABLE_SELF', 'You cannot disable your own account');
        }
        if (body.isAdmin === false) {
          throw conflict('CANNOT_DEMOTE_SELF', 'You cannot remove your own administrator role');
        }
      }

      const removingAdmin =
        user.is_admin === 1 && (body.isAdmin === false || body.disabled === true);
      if (removingAdmin && adminCount(app.db) <= 1) {
        throw forbidden('LAST_ADMIN', 'At least one active administrator is required');
      }

      const updated = updateUserFlags(app.db, userId, body);
      if (!updated) throw notFound('USER_NOT_FOUND', 'User not found');

      if (updated.disabled === 1) {
        app.hub.dropUser(updated.id);
      }

      return { user: toPublicUser(updated) };
    },
  );
}
