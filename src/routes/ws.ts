import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { SERVER_VERSION } from '../config.js';
import { getDevice } from '../db/devices.js';
import { findUserById } from '../db/users.js';
import { requireVaultAccess } from '../db/vaults.js';

const wsQuerySchema = z.object({
  ticket: z.string().min(10).max(256),
});

function sendJson(socket: WebSocket, payload: unknown): void {
  if (socket.readyState !== 1) return;
  try {
    socket.send(JSON.stringify(payload));
  } catch {
    socket.terminate();
  }
}

export async function registerWsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/ws', { websocket: true }, (socket: WebSocket, request) => {
    const parsed = wsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      socket.close(4401, 'A valid ticket is required');
      return;
    }

    const ticket = app.tickets.consume(parsed.data.ticket);
    if (!ticket) {
      socket.close(4401, 'Ticket is invalid or expired');
      return;
    }

    const user = findUserById(app.db, ticket.userId);
    if (!user || user.disabled === 1) {
      socket.close(4401, 'Account is not active');
      return;
    }
    if (ticket.deviceId && !getDevice(app.db, user.id, ticket.deviceId)) {
      socket.close(4401, 'Device has been removed');
      return;
    }

    app.hub.add(socket, user.id, ticket.deviceId);

    sendJson(socket, {
      type: 'hello',
      userId: user.id,
      deviceId: ticket.deviceId,
      serverVersion: SERVER_VERSION,
      serverTime: Date.now(),
    });

    socket.on('message', (raw) => {
      app.hub.markAlive(socket);

      let message: unknown;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        sendJson(socket, { type: 'error', code: 'INVALID_JSON', message: 'Message must be JSON' });
        return;
      }

      if (
        typeof message !== 'object' ||
        message === null ||
        typeof (message as { type?: unknown }).type !== 'string'
      ) {
        sendJson(socket, {
          type: 'error',
          code: 'INVALID_MESSAGE',
          message: 'Missing message type',
        });
        return;
      }

      const typed = message as { type: string; vaultId?: unknown };

      if (typed.type === 'ping') {
        sendJson(socket, { type: 'pong', serverTime: Date.now() });
        return;
      }

      if (typed.type === 'subscribe') {
        if (typeof typed.vaultId !== 'string' || typed.vaultId.length === 0) {
          sendJson(socket, {
            type: 'error',
            code: 'INVALID_VAULT_ID',
            message: 'vaultId is required',
          });
          return;
        }

        try {
          const access = requireVaultAccess(app.db, typed.vaultId, user.id);
          app.hub.subscribe(socket, typed.vaultId);
          sendJson(socket, {
            type: 'subscribed',
            vaultId: typed.vaultId,
            revision: access.vault.revision,
          });
        } catch {
          sendJson(socket, {
            type: 'error',
            code: 'VAULT_NOT_FOUND',
            message: 'Vault not found',
            vaultId: typed.vaultId,
          });
        }
        return;
      }

      if (typed.type === 'unsubscribe') {
        if (typeof typed.vaultId === 'string') {
          app.hub.unsubscribe(socket, typed.vaultId);
          sendJson(socket, { type: 'unsubscribed', vaultId: typed.vaultId });
        }
        return;
      }

      sendJson(socket, {
        type: 'error',
        code: 'UNKNOWN_MESSAGE',
        message: `Unknown message type: ${typed.type}`,
      });
    });

    socket.on('pong', () => {
      app.hub.markAlive(socket);
    });

    socket.on('close', () => {
      app.hub.remove(socket);
    });

    socket.on('error', () => {
      app.hub.remove(socket);
    });
  });
}
