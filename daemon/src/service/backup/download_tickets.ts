import crypto from "crypto";
import { BACKUP_DOWNLOAD_TICKET_TTL_MS } from "mcsmanager-common";

interface Ticket {
  instanceUuid: string;
  filePath: string;
  fileName: string;
  expiresAt: number;
}

const MAX_TICKETS = 500;

export type TicketLookup =
  | { state: "none" }
  | { state: "expired" }
  | { state: "valid"; filePath: string; fileName: string };

/**
 * Single-use, short-lived tickets that map to ONE archive file chosen by the daemon
 * (ticket -> record -> file). No path coming from a client is ever used.
 */
export class BackupDownloadTickets {
  private readonly tickets = new Map<string, Ticket>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = BACKUP_DOWNLOAD_TICKET_TTL_MS
  ) {}

  issue(instanceUuid: string, filePath: string, fileName: string) {
    const now = this.now();
    for (const [k, t] of this.tickets) if (t.expiresAt <= now) this.tickets.delete(k);
    while (this.tickets.size >= MAX_TICKETS) {
      const oldest = this.tickets.keys().next().value as string;
      this.tickets.delete(oldest);
    }
    const ticket = crypto.randomBytes(24).toString("hex");
    const expiresAt = now + this.ttlMs;
    this.tickets.set(ticket, { instanceUuid, filePath, fileName, expiresAt });
    return { ticket, expiresAt };
  }

  /** Look a ticket up for one instance without consuming it. */
  lookup(ticket: unknown, instanceUuid: string): TicketLookup {
    if (typeof ticket !== "string" || !/^[0-9a-f]{48}$/.test(ticket)) return { state: "none" };
    const t = this.tickets.get(ticket);
    if (!t || t.instanceUuid !== instanceUuid) return { state: "none" };
    if (t.expiresAt <= this.now()) {
      this.tickets.delete(ticket);
      return { state: "expired" };
    }
    return { state: "valid", filePath: t.filePath, fileName: t.fileName };
  }

  /** Burn a ticket after a successful transfer. */
  consume(ticket: string) {
    this.tickets.delete(ticket);
  }
}

export const backupDownloadTickets = new BackupDownloadTickets();
