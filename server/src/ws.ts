import type { WebSocket } from 'ws';
import type { WsMessage } from '@seamless/shared';

const clients = new Map<WebSocket, number>(); // socket -> userId

export function addClient(ws: WebSocket, userId: number): void {
  clients.set(ws, userId);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
}

/** Send to one user's open sockets, or every socket when userId is omitted. */
export function broadcast(msg: WsMessage, userId?: number): void {
  const data = JSON.stringify(msg);
  for (const [ws, uid] of clients) {
    if (userId !== undefined && uid !== userId) continue;
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}
