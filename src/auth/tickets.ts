import { randomBytes } from 'node:crypto';

interface TicketRecord {
  userId: string;
  deviceId: string | null;
  expiresAt: number;
}

export interface Ticket {
  userId: string;
  deviceId: string | null;
}

export class WsTicketStore {
  private readonly tickets = new Map<string, TicketRecord>();
  private readonly ttlMs = 60_000;

  create(userId: string, deviceId: string | null): { ticket: string; expiresAt: number } {
    this.prune();
    if (this.tickets.size > 20_000) {
      const oldest = this.tickets.keys().next().value;
      if (oldest) this.tickets.delete(oldest);
    }

    const ticket = randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + this.ttlMs;
    this.tickets.set(ticket, { userId, deviceId, expiresAt });
    return { ticket, expiresAt };
  }

  consume(ticket: string): Ticket | null {
    const record = this.tickets.get(ticket);
    if (!record) return null;
    this.tickets.delete(ticket);
    if (record.expiresAt <= Date.now()) return null;
    return { userId: record.userId, deviceId: record.deviceId };
  }

  prune(): void {
    const now = Date.now();
    for (const [ticket, record] of this.tickets) {
      if (record.expiresAt <= now) this.tickets.delete(ticket);
    }
  }

  clear(): void {
    this.tickets.clear();
  }
}
