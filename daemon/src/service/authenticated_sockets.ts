import type { Socket } from "socket.io";
import RouterContext from "../entity/ctx";
import logger from "./log";
import { msg } from "./protocol";

/**
 * Sockets that completed the top-level `auth` handshake (the panel connections).
 * `protocol.broadcast` reaches every connected socket, including unauthenticated ones, so
 * anything that must only reach an authenticated panel goes through this registry instead.
 */
const authenticated = new Set<Socket>();

export function register(socket: Socket) {
  if (authenticated.has(socket)) return;
  authenticated.add(socket);
  socket.once("disconnect", () => authenticated.delete(socket));
}

export function hasAuthenticatedPanel(): boolean {
  for (const socket of authenticated) {
    if (!socket.connected) authenticated.delete(socket);
  }
  return authenticated.size > 0;
}

/** Send an event to every connected, authenticated panel socket. */
export function broadcast(event: string, data: unknown): void {
  for (const socket of [...authenticated]) {
    if (!socket.connected) {
      authenticated.delete(socket);
      continue;
    }
    try {
      msg(new RouterContext(null, socket), event, data);
    } catch (err) {
      logger.debug(`Authenticated panel emit failed for ${event}`, err);
    }
  }
}
