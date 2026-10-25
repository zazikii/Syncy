import type { FastifyInstance } from 'fastify';
import { deleteDevice, listDevices, renameDevice, toPublicDevice } from '../db/devices.js';
import { revokeDeviceTokens } from '../db/tokens.js';
import { deviceParams, updateDeviceSchema } from './schemas.js';

export async function registerDeviceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/devices', { preHandler: app.authenticate }, async (request) => {
    const devices = listDevices(app.db, request.auth!.user.id);
    return {
      currentDeviceId: request.auth!.deviceId,
      devices: devices.map(toPublicDevice),
    };
  });

  app.patch('/v1/devices/:deviceId', { preHandler: app.authenticate }, async (request) => {
    const { deviceId } = deviceParams.parse(request.params);
    const body = updateDeviceSchema.parse(request.body);
    const updated = renameDevice(app.db, request.auth!.user.id, deviceId, body.name);
    return { device: toPublicDevice(updated) };
  });

  app.delete('/v1/devices/:deviceId', { preHandler: app.authenticate }, async (request, reply) => {
    const { deviceId } = deviceParams.parse(request.params);
    revokeDeviceTokens(app.db, request.auth!.user.id, deviceId);
    deleteDevice(app.db, request.auth!.user.id, deviceId);
    return reply.status(204).send();
  });
}
