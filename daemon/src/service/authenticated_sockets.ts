import { Socket } from "socket.io";
import RouterContext from "../entity/ctx";
import { msg } from "./protocol";

/**
 * Sockets that completed the top-level `auth` handshake (the panel connections).
 * `protocol.broadcast` reaches every connected socket, including unauthenticated ones, so
 * anything that must only reach an authenticated panel goes through this registry instead.
 */
const authenticated = new Set<Socket>();

export function addAuthenticatedSocket(socket: Socket) {
  authenticated.add(socket);
  socket.once("disconnect", () => authenticated.delete(socket));
}

export function removeAuthenticatedSocket(socket: Socket) {
  authenticated.delete(socket);
}

export function authenticatedSocketCount(): number {
  for (const s of authenticated) if (s.disconnected) authenticated.delete(s);
  return authenticated.size;
}

/** Send an event to every authenticated panel socket. Returns how many sockets were targeted. */
export function broadcastToAuthenticated(event: string, payload: unknown): number {
  let n = 0;
  for (const socket of [...authenticated]) {
    if (socket.disconnected) {
      authenticated.delete(socket);
      continue;
    }
    msg(new RouterContext(null, socket), event, payload);
    n++;
  }
  return n;
}
