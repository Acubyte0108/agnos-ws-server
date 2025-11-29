import { WebSocketServer } from "ws";

const CONFIG = {
  PORT: process.env.PORT ? Number(process.env.PORT) : 4000,
  HEARTBEAT_INTERVAL: 30000, // 30 seconds
  CLIENT_TIMEOUT: 60000, // 60 seconds
  PROGRESS_FIELDS: ["firstName", "lastName", "phone", "email"],
  STATS_INTERVAL: 60000, // Log stats every 60 seconds
};

const rooms = new Map(); // Map<roomId, Set<ws>>
const clients = new Map(); // Map<ws, { ws, room, clientId, joinedAt, lastActivity, status }>

// ============================================================================
// Helper Functions
// ============================================================================

function log(level, message, ...args) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}]`, message, ...args);
}

function parseMessage(data) {
  try {
    const raw = typeof data === "string" ? data : data.toString();
    const msg = JSON.parse(raw);

    // Basic validation
    if (!msg.type || !msg.clientId) {
      log("WARN", "Invalid message format - missing type or clientId");
      return null;
    }

    return msg;
  } catch (err) {
    log("ERROR", "Failed to parse message:", err);
    return null;
  }
}

function computeProgress(payload) {
  if (!payload) return 0;
  const filled = CONFIG.PROGRESS_FIELDS.filter(
    (field) => !!payload[field]
  ).length;
  return Math.round((filled / CONFIG.PROGRESS_FIELDS.length) * 100);
}

function broadcast(roomId, message, except) {
  const roomClients = rooms.get(roomId);
  if (!roomClients) return;

  let sentCount = 0;
  for (const client of roomClients) {
    if (client !== except && client.readyState === client.OPEN) {
      try {
        client.send(message);
        sentCount++;
      } catch (err) {
        log("ERROR", `Failed to send to client in room ${roomId}:`, err);
      }
    }
  }

  if (sentCount > 0) {
    log("INFO", `Broadcast to room "${roomId}": ${sentCount} clients`);
  }
}

function addClientToRoom(ws, room, clientId) {
  if (!rooms.has(room)) {
    rooms.set(room, new Set());
    log("INFO", `Created new room: "${room}"`);
  }

  rooms.get(room).add(ws);

  clients.set(ws, {
    ws,
    room,
    clientId,
    joinedAt: Date.now(),
    lastActivity: Date.now(),
    status: "online",
  });

  log("INFO", `Client "${clientId || "anonymous"}" joined room "${room}"`);
  log("INFO", `Room "${room}" now has ${rooms.get(room).size} clients`);

  // Only notify when patient joins dashboard room (avoids duplicates)
  // Staff-dashboard is excluded
  if (clientId && room === "dashboard" && clientId !== "staff-dashboard") {
    notifyPatientConnected(clientId);
  }
}

function removeClientFromRoom(ws) {
  const clientInfo = clients.get(ws);
  if (!clientInfo) return;

  const { room, clientId } = clientInfo;
  const roomClients = rooms.get(room);

  if (roomClients) {
    roomClients.delete(ws);

    if (roomClients.size === 0) {
      rooms.delete(room);
      log("INFO", `Room "${room}" is empty and removed`);
    } else {
      log("INFO", `Room "${room}" now has ${roomClients.size} clients`);
    }
  }

  clients.delete(ws);
  log(
    "INFO",
    `Client "${clientId || "anonymous"}" disconnected from room "${room}"`
  );

  // Only notify when patient leaves dashboard room
  if (clientId && room === "dashboard" && clientId !== "staff-dashboard") {
    notifyPatientDisconnected(clientId);
  }
}

function updateClientActivity(ws) {
  const clientInfo = clients.get(ws);
  if (clientInfo) {
    clientInfo.lastActivity = Date.now();
  }
}

function updateClientStatus(ws, status) {
  const clientInfo = clients.get(ws);
  if (clientInfo) {
    clientInfo.status = status;
    log("INFO", `Client "${clientInfo.clientId}" status: ${status}`);
  }
}

// ============================================================================
// Notification Functions
// ============================================================================

function notifyPatientConnected(clientId) {
  const connectMessage = {
    type: "patientConnected",
    clientId: clientId,
    timestamp: Date.now(),
  };

  broadcast("dashboard", JSON.stringify(connectMessage));
  log("INFO", `✅ Notified dashboard: Patient "${clientId}" connected`);
}

function notifyPatientDisconnected(clientId) {
  const disconnectMessage = {
    type: "patientDisconnected",
    clientId: clientId,
    timestamp: Date.now(),
  };

  broadcast("dashboard", JSON.stringify(disconnectMessage));
  log("INFO", `❌ Notified dashboard: Patient "${clientId}" disconnected`);
}

function sendCurrentStateToStaff(staffWs) {
  // Collect all currently active patients from dashboard room
  const dashboardRoom = rooms.get("dashboard");
  if (!dashboardRoom) return;

  const activePatients = [];

  // Find all patient connections (not staff)
  dashboardRoom.forEach((ws) => {
    const clientInfo = clients.get(ws);
    if (
      clientInfo &&
      clientInfo.clientId &&
      clientInfo.clientId !== "staff-dashboard"
    ) {
      activePatients.push({
        clientId: clientInfo.clientId,
        status: clientInfo.status || "online",
        joinedAt: clientInfo.joinedAt,
        lastActivity: clientInfo.lastActivity,
      });
    }
  });

  if (activePatients.length > 0) {
    log(
      "INFO",
      `📋 Sending ${activePatients.length} active patients to new staff connection`
    );

    // Send initial state message
    try {
      staffWs.send(
        JSON.stringify({
          type: "initialState",
          payload: activePatients,
          timestamp: Date.now(),
        })
      );
    } catch (err) {
      log("ERROR", "Failed to send initial state:", err);
    }
  }
}

// ============================================================================
// Message Handlers
// ============================================================================

function handleMessage(ws, data) {
  const msg = parseMessage(data);
  if (!msg) return;

  updateClientActivity(ws);

  const clientInfo = clients.get(ws);
  if (!clientInfo) return;

  const { room, clientId } = clientInfo;

  log("INFO", `📨 Message from "${clientId}" in room "${room}": ${msg.type}`);

  // Broadcast to same room (except sender)
  broadcast(room, JSON.stringify(msg), ws);

  // Handle different message types
  switch (msg.type) {
    case "summary":
    case "formSnapshot":
    case "formUpdate":
      handleFormUpdate(msg, room);
      break;

    case "status":
      handleStatusUpdate(ws, msg);
      break;

    case "submit":
      handleFormSubmit(msg, room);
      break;

    default:
      log("INFO", `Unknown message type: ${msg.type}`);
  }
}

function handleFormUpdate(msg, sourceRoom) {
  // Don't forward dashboard messages back to dashboard
  if (sourceRoom === "dashboard") return;

  // Create lightweight summary for dashboard
  const summary = {
    type: "summary",
    clientId: msg.clientId,
    payload: {
      firstName: msg.payload?.firstName || null,
      lastName: msg.payload?.lastName || null,
      progress: msg.payload?.progress ?? computeProgress(msg.payload),
      submitted: msg.payload?.submitted || false,
    },
    timestamp: msg.timestamp || Date.now(),
  };

  broadcast("dashboard", JSON.stringify(summary));
  log(
    "INFO",
    `📊 Forwarded summary to dashboard for "${msg.clientId}" (${summary.payload.progress}%)`
  );
}

function handleStatusUpdate(ws, msg) {
  const { clientId, state } = msg;

  // Update client status in memory
  updateClientStatus(ws, state);

  log("INFO", `🔔 Status update from "${clientId}": ${state}`);

  // Forward status to dashboard (already broadcasts via handleMessage)
  // Status changes are already broadcast to the room, so dashboard receives them
}

function handleFormSubmit(msg, sourceRoom) {
  log("INFO", `✅ Form submitted by "${msg.clientId}"`);

  // Forward to dashboard if not from dashboard
  if (sourceRoom !== "dashboard") {
    const submitNotification = {
      type: "summary",
      clientId: msg.clientId,
      payload: {
        ...msg.payload,
        progress: 100,
        submitted: true,
      },
      timestamp: msg.timestamp || Date.now(),
    };

    broadcast("dashboard", JSON.stringify(submitNotification));
  }
}

// ============================================================================
// Connection Management
// ============================================================================

function setupHeartbeat() {
  const interval = setInterval(() => {
    const now = Date.now();

    clients.forEach((clientInfo, ws) => {
      // Check if client is stale
      if (now - clientInfo.lastActivity > CONFIG.CLIENT_TIMEOUT) {
        log(
          "WARN",
          `⏱️  Client "${clientInfo.clientId}" timed out - terminating`
        );
        ws.terminate();
        return;
      }

      // Send ping
      if (ws.readyState === ws.OPEN) {
        try {
          ws.ping();
        } catch (err) {
          log("ERROR", `Failed to ping client "${clientInfo.clientId}":`, err);
        }
      }
    });
  }, CONFIG.HEARTBEAT_INTERVAL);

  log(
    "INFO",
    `💓 Heartbeat started (interval: ${CONFIG.HEARTBEAT_INTERVAL}ms)`
  );
  return interval;
}

function getRoomFromRequest(req) {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const room = url.searchParams.get("room") || "lobby";
  const clientId = url.searchParams.get("clientId") || undefined;

  return { room, clientId };
}

// ============================================================================
// WebSocket Server Setup
// ============================================================================

const wss = new WebSocketServer({ port: CONFIG.PORT });

log("INFO", `🚀 WebSocket server listening on ws://0.0.0.0:${CONFIG.PORT}`);
log(
  "INFO",
  `⚙️  Configuration: Heartbeat=${CONFIG.HEARTBEAT_INTERVAL}ms, Timeout=${CONFIG.CLIENT_TIMEOUT}ms`
);

wss.on("connection", (ws, req) => {
  const { room, clientId } = getRoomFromRequest(req);

  log(
    "INFO",
    `🔌 New connection - Room: "${room}", ClientId: "${clientId || "none"}"`
  );

  addClientToRoom(ws, room, clientId);

  // NEW: Send current state to staff when they join dashboard
  if (room === "dashboard" && clientId === "staff-dashboard") {
    // Give a small delay to ensure connection is fully established
    setTimeout(() => {
      sendCurrentStateToStaff(ws);
    }, 100);
  }

  // Handle incoming messages
  ws.on("message", (data) => {
    handleMessage(ws, data);
  });

  // Handle pong (response to ping)
  ws.on("pong", () => {
    updateClientActivity(ws);
  });

  // Handle errors
  ws.on("error", (error) => {
    const clientInfo = clients.get(ws);
    log(
      "ERROR",
      `⚠️  WebSocket error for "${clientInfo?.clientId}":`,
      error.message
    );
  });

  // Handle disconnection
  ws.on("close", (code, reason) => {
    const clientInfo = clients.get(ws);
    log(
      "INFO",
      `👋 Client "${clientInfo?.clientId}" closing - Code: ${code}, Reason: ${
        reason || "none"
      }`
    );
    removeClientFromRoom(ws);
  });

  // Send welcome message
  try {
    ws.send(
      JSON.stringify({
        type: "connected",
        clientId: clientId || "anonymous",
        room,
        timestamp: Date.now(),
        message: "Welcome to the WebSocket server",
      })
    );
  } catch (err) {
    log("ERROR", "Failed to send welcome message:", err);
  }
});

// ============================================================================
// Server Lifecycle & Monitoring
// ============================================================================

// Setup heartbeat
const heartbeatInterval = setupHeartbeat();

// Log server stats periodically
const statsInterval = setInterval(() => {
  log(
    "INFO",
    `📊 Server stats - Rooms: ${rooms.size}, Total clients: ${clients.size}`
  );

  // Log room details
  rooms.forEach((clientSet, roomId) => {
    const clientList = Array.from(clientSet)
      .map((ws) => {
        const info = clients.get(ws);
        return info ? `${info.clientId}(${info.status})` : "unknown";
      })
      .join(", ");

    log(
      "INFO",
      `   Room "${roomId}": ${clientSet.size} client(s) - [${clientList}]`
    );
  });
}, CONFIG.STATS_INTERVAL);

// Graceful shutdown handler
function shutdown(signal) {
  log("INFO", `${signal} received - shutting down gracefully...`);

  clearInterval(heartbeatInterval);
  clearInterval(statsInterval);

  // Notify all clients about shutdown
  wss.clients.forEach((ws) => {
    try {
      ws.send(
        JSON.stringify({
          type: "serverShutdown",
          message: "Server is shutting down",
          timestamp: Date.now(),
        })
      );
    } catch (err) {
      // Ignore errors when notifying
    }
    ws.close(1000, "Server shutting down");
  });

  wss.close(() => {
    log("INFO", "✅ WebSocket server closed successfully");
    process.exit(0);
  });

  // Force exit after 5 seconds if graceful shutdown fails
  setTimeout(() => {
    log("ERROR", "⚠️  Forced shutdown after timeout");
    process.exit(1);
  }, 5000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Handle uncaught errors
process.on("uncaughtException", (err) => {
  log("ERROR", "💥 Uncaught Exception:", err);
  shutdown("UNCAUGHT_EXCEPTION");
});

process.on("unhandledRejection", (reason, promise) => {
  log("ERROR", "💥 Unhandled Rejection at:", promise, "reason:", reason);
});

log("INFO", "✅ WebSocket server initialization complete");
