import { WebSocketServer } from 'ws';

const port = process.env.PORT ? Number(process.env.PORT) : 4000;
const wss = new WebSocketServer({ port });

console.log(`WebSocket server listening on ws://0.0.0.0:${port}`);

const rooms = new Map(); // Map<roomId, Set<ws>>

function broadcast(roomId, message, except) {
  const clients = rooms.get(roomId);
  if (!clients) return;
  for (const c of clients) {
    if (c !== except && c.readyState === c.OPEN) c.send(message);
  }
}

wss.on('connection', (ws, req) => {
  console.log('NEW CLIENT CONNECTED'); 
  const url = new URL(req.url, `http://${req.headers.host}`);
  const room = url.searchParams.get('room') || 'lobby';

  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(ws);

  ws.on('message', (data) => {
    try {
      const msg = typeof data === 'string' ? JSON.parse(data) : JSON.parse(data.toString());
      broadcast(room, JSON.stringify(msg), ws);
    } catch (err) {
      console.warn('Invalid message', err);
    }
  });

  ws.on('close', () => {
    const s = rooms.get(room);
    if (s) {
      s.delete(ws);
      if (s.size === 0) rooms.delete(room);
    }
  });
});