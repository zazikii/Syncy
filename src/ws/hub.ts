import type { WebSocket } from 'ws';

interface ClientRecord {
  socket: WebSocket;
  userId: string;
  deviceId: string | null;
  vaults: Set<string>;
  alive: boolean;
}

export type VaultEvent =
  | {
      type: 'vault_changed';
      vaultId: string;
      revision: number;
      actorUserId: string;
      originDeviceId: string | null;
    }
  | { type: 'vault_deleted'; vaultId: string; actorUserId: string }
  | { type: 'vault_members_changed'; vaultId: string; actorUserId: string };

export class WsHub {
  private readonly clients = new Map<WebSocket, ClientRecord>();

  add(socket: WebSocket, userId: string, deviceId: string | null): void {
    this.clients.set(socket, {
      socket,
      userId,
      deviceId,
      vaults: new Set(),
      alive: true,
    });
  }

  remove(socket: WebSocket): void {
    this.clients.delete(socket);
  }

  get size(): number {
    return this.clients.size;
  }

  subscribe(socket: WebSocket, vaultId: string): void {
    this.clients.get(socket)?.vaults.add(vaultId);
  }

  unsubscribe(socket: WebSocket, vaultId: string): void {
    this.clients.get(socket)?.vaults.delete(vaultId);
  }

  markAlive(socket: WebSocket): void {
    const client = this.clients.get(socket);
    if (client) client.alive = true;
  }

  heartbeat(): void {
    for (const [socket, client] of this.clients) {
      if (!client.alive) {
        socket.terminate();
        this.clients.delete(socket);
        continue;
      }
      client.alive = false;
      try {
        socket.ping();
      } catch {
        socket.terminate();
        this.clients.delete(socket);
      }
    }
  }

  broadcastVault(vaultId: string, event: VaultEvent): void {
    const payload = JSON.stringify(event);
    for (const client of this.clients.values()) {
      if (!client.vaults.has(vaultId)) continue;
      if (client.socket.readyState !== 1) continue;
      try {
        client.socket.send(payload);
      } catch {
        client.socket.terminate();
        this.clients.delete(client.socket);
      }
    }
  }

  dropVaultMember(vaultId: string, userId: string): void {
    for (const client of this.clients.values()) {
      if (client.userId !== userId || !client.vaults.has(vaultId)) continue;
      client.vaults.delete(vaultId);
      if (client.socket.readyState === 1) {
        try {
          client.socket.send(
            JSON.stringify({
              type: 'unsubscribed',
              vaultId,
              reason: 'membership_changed',
            }),
          );
        } catch {
          client.socket.terminate();
        }
      }
    }
  }

  dropVault(vaultId: string): void {
    for (const client of this.clients.values()) {
      client.vaults.delete(vaultId);
    }
  }

  dropUser(userId: string): void {
    for (const [socket, client] of this.clients) {
      if (client.userId !== userId) continue;
      this.clients.delete(socket);
      try {
        socket.close(1008, 'Account access revoked');
      } catch {
        socket.terminate();
      }
    }
  }

  closeAll(): void {
    for (const client of this.clients.values()) {
      try {
        client.socket.close(1001, 'Server shutting down');
      } catch {
        client.socket.terminate();
      }
    }
    this.clients.clear();
  }
}
