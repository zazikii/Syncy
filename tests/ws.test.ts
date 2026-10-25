import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import type { TestContext } from './helpers.js';
import {
  auth,
  createDbUser,
  createTestApp,
  createVault,
  login,
  pushChanges,
  type Session,
  setupAdmin,
} from './helpers.js';

interface Message {
  type: string;
  [key: string]: unknown;
}

interface SocketClient {
  socket: WebSocket;
  next: (predicate: (message: Message) => boolean) => Promise<Message>;
  close: () => Promise<void>;
}

function connect(url: string): Promise<SocketClient> {
  const socket = new WebSocket(url);
  const queue: Message[] = [];
  const waiters: Array<{
    predicate: (message: Message) => boolean;
    resolve: (message: Message) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  socket.on('message', (data) => {
    let message: Message;
    try {
      message = JSON.parse(data.toString()) as Message;
    } catch {
      return;
    }
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex >= 0) {
      const waiter = waiters.splice(waiterIndex, 1)[0]!;
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      queue.push(message);
    }
  });

  const next = (predicate: (message: Message) => boolean): Promise<Message> => {
    const queuedIndex = queue.findIndex(predicate);
    if (queuedIndex >= 0) {
      return Promise.resolve(queue.splice(queuedIndex, 1)[0]!);
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('Timed out waiting for websocket message'));
        }, 5000),
      };
      waiters.push(waiter);
    });
  };

  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve({ socket, next, close: () => closeSocket(socket) }));
    socket.once('error', reject);
  });
}

function closeSocket(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    socket.once('close', () => resolve());
    socket.close();
  });
}

async function issueTicket(app: TestContext['app'], token: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/ws-ticket',
    headers: auth(token),
  });
  expect(response.statusCode).toBe(200);
  return response.json().ticket as string;
}

describe('websocket notifications', () => {
  let ctx: TestContext;
  let owner: Session;
  let vault: { id: string };
  let baseUrl: string;
  const sockets: SocketClient[] = [];

  beforeEach(async () => {
    ctx = await createTestApp();
    owner = await setupAdmin(ctx.app);
    vault = await createVault(ctx.app, owner.accessToken);
    const address = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    baseUrl = address.replace(/^http/, 'ws');
  });

  afterEach(async () => {
    await Promise.all(sockets.map((client) => client.close()));
    sockets.length = 0;
    await ctx.close();
  });

  test('subscribes to a vault and receives changes', async () => {
    const ticket = await issueTicket(ctx.app, owner.accessToken);
    const client = await connect(`${baseUrl}/v1/ws?ticket=${ticket}`);
    sockets.push(client);

    const hello = await client.next((message) => message.type === 'hello');
    expect(hello).toMatchObject({ userId: owner.user.id, deviceId: owner.deviceId });

    client.socket.send(JSON.stringify({ type: 'subscribe', vaultId: vault.id }));
    const subscribed = await client.next((message) => message.type === 'subscribed');
    expect(subscribed).toMatchObject({ vaultId: vault.id, revision: 0 });

    const pushed = await pushChanges(ctx.app, owner.accessToken, vault.id, [
      {
        fileId: 'folder-1',
        path: 'Folder',
        kind: 'folder',
        expectedRevision: null,
      },
    ]);
    expect(pushed.statusCode).toBe(200);

    const changed = await client.next((message) => message.type === 'vault_changed');
    expect(changed).toMatchObject({
      vaultId: vault.id,
      revision: 1,
      actorUserId: owner.user.id,
      originDeviceId: owner.deviceId,
    });

    client.socket.send(JSON.stringify({ type: 'ping' }));
    const pong = await client.next((message) => message.type === 'pong');
    expect(pong).toHaveProperty('serverTime');
  });

  test('rejects invalid tickets', async () => {
    const socket = new WebSocket(`${baseUrl}/v1/ws?ticket=not-a-valid-ticket`);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    socket.on('error', () => undefined);

    const result = await closed;
    expect(result.code).toBe(4401);
  });

  test('unsubscribes removed members from their live connection', async () => {
    await createDbUser(ctx.app, 'reader@example.com', 'reader-password-123');
    const reader = await login(ctx.app, 'reader@example.com', 'reader-password-123');

    await ctx.app.inject({
      method: 'POST',
      url: `/v1/vaults/${vault.id}/members`,
      headers: auth(owner.accessToken),
      payload: { email: 'reader@example.com', role: 'reader' },
    });

    const ticket = await issueTicket(ctx.app, reader.accessToken);
    const client = await connect(`${baseUrl}/v1/ws?ticket=${ticket}`);
    sockets.push(client);
    await client.next((message) => message.type === 'hello');
    client.socket.send(JSON.stringify({ type: 'subscribe', vaultId: vault.id }));
    await client.next((message) => message.type === 'subscribed');

    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/v1/vaults/${vault.id}/members/${reader.user.id}`,
      headers: auth(owner.accessToken),
    });
    expect(removed.statusCode).toBe(204);

    const unsubscribed = await client.next((message) => message.type === 'unsubscribed');
    expect(unsubscribed).toMatchObject({
      vaultId: vault.id,
      reason: 'membership_changed',
    });
  });
});
