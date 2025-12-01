import { WebSocketServer } from "ws";

const CONFIG = {
  PORT: process.env.PORT ? Number(process.env.PORT) : 4000,
  HEARTBEAT_INTERVAL: 30000, // 30 seconds
  CLIENT_TIMEOUT: 60000, // 60 seconds
  STATS_INTERVAL: 60000, // Log stats every 60 seconds
  REMOVAL_DELAY: 20000, // 20 seconds before removing disconnected/submitted patients
};

const rooms = new Map(); // Map<roomId, Set<ws>>
const clients = new Map(); // Map<ws, { ws, room, clientId, joinedAt, lastActivity, status }>
const patientSummaries = new Map(); // Map<clientId, latestFormSummary> - for patient rooms
const dashboardSnapshots = new Map(); // Map<clientId, dashboardData> - for dashboard room
const removalTimers = new Map(); // Map<clientId, timeoutId> - track scheduled removals

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

// Send current snapshot to a specific client (staff joining patient room)
function sendCurrentSnapshotToClient(ws, patientId) {
  const summary = patientSummaries.get(patientId);

  if (summary) {
    log(
      "INFO",
      `📋 Sending current snapshot to new client in room "${patientId}"`
    );

    try {
      ws.send(
        JSON.stringify({
          type: "formSnapshot",
          clientId: patientId,
          payload: summary,
          timestamp: Date.now(),
        })
      );
    } catch (err) {
      log("ERROR", "Failed to send snapshot to client:", err);
    }
  } else {
    log("INFO", `No snapshot available for patient "${patientId}"`);
  }
}

// Send complete dashboard snapshot to staff
function sendDashboardSnapshot(staffWs) {
  const activePatients = [];

  // Get ALL patients from dashboard snapshots
  dashboardSnapshots.forEach((snapshot, clientId) => {
    activePatients.push(snapshot);
    log("INFO", `   - Including patient "${clientId}" from dashboard snapshot`);
  });

  if (activePatients.length > 0) {
    log(
      "INFO",
      `📋 Sending dashboard snapshot with ${activePatients.length} patients`
    );

    try {
      staffWs.send(
        JSON.stringify({
          type: "initialState",
          payload: activePatients,
          timestamp: Date.now(),
        })
      );
    } catch (err) {
      log("ERROR", "Failed to send dashboard snapshot:", err);
    }
  } else {
    log("INFO", "📋 Dashboard snapshot is empty");
  }
}

// Schedule removal of a patient from dashboard
function schedulePatientRemoval(clientId, reason) {
  // Clear any existing timer for this patient
  if (removalTimers.has(clientId)) {
    clearTimeout(removalTimers.get(clientId));
    log("INFO", `Cleared existing removal timer for "${clientId}"`);
  }

  // Schedule new removal
  const timerId = setTimeout(() => {
    log(
      "INFO",
      `🧹 Removing ${reason} patient "${clientId}" after ${
        CONFIG.REMOVAL_DELAY / 1000
      }s`
    );

    // Remove from all snapshots
    dashboardSnapshots.delete(clientId);
    patientSummaries.delete(clientId);
    removalTimers.delete(clientId);

    // Notify all staff to remove this patient
    broadcast(
      "dashboard",
      JSON.stringify({
        type: "patientRemoved",
        clientId: clientId,
        timestamp: Date.now(),
      })
    );
  }, CONFIG.REMOVAL_DELAY);

  removalTimers.set(clientId, timerId);
  log(
    "INFO",
    `⏰ Scheduled ${reason} removal for "${clientId}" in ${
      CONFIG.REMOVAL_DELAY / 1000
    }s`
  );
}

function addClientToRoom(ws, room, clientId) {
  if (!rooms.has(room)) {
    rooms.set(room, new Set());
    log("INFO", `Created new room: "${room}"`);
  }

  const roomSize = rooms.get(room).size;
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

  // PATIENT joins dashboard room - notify and create their snapshot
  if (clientId && room === "dashboard" && !clientId.startsWith("staff-")) {
    // Cancel any pending removal if patient reconnects
    if (removalTimers.has(clientId)) {
      clearTimeout(removalTimers.get(clientId));
      removalTimers.delete(clientId);
      log(
        "INFO",
        `Cancelled removal timer for reconnected patient "${clientId}"`
      );
    }

    // IMPORTANT: Get existing snapshot to preserve summary data
    const existingSnapshot = dashboardSnapshots.get(clientId);
    
    // Check if we have data in patientSummaries (from patient room)
    const patientData = patientSummaries.get(clientId);
    
    // Determine what summary to use
    let summary = {};
    if (existingSnapshot?.summary && Object.keys(existingSnapshot.summary).length > 0) {
      // Preserve existing summary if it exists and has data
      summary = existingSnapshot.summary;
      log("INFO", `Preserving existing summary for "${clientId}" with progress: ${summary.progress || 0}`);
    } else if (patientData) {
      // Use patient room data if available
      summary = {
        firstName: patientData.firstName || null,
        lastName: patientData.lastName || null,
        progress: patientData.progress || 0,
        submitted: patientData.submitted || false,
      };
      log("INFO", `Using patient room data for "${clientId}" with progress: ${summary.progress || 0}`);
    }

    const reconnectSnapshot = {
      ...existingSnapshot,
      clientId: clientId,
      status: "online",
      joinedAt: existingSnapshot?.joinedAt || Date.now(),
      lastActivity: Date.now(),
      summary: summary,  // Use preserved or existing summary
    };
    
    dashboardSnapshots.set(clientId, reconnectSnapshot);
    log("INFO", `Updated dashboard snapshot for "${clientId}"`, reconnectSnapshot);

    notifyPatientConnected(clientId);
  }

  // STAFF joins dashboard room - send them ALL snapshots
  if (clientId && room === "dashboard" && clientId.startsWith("staff-")) {
    setTimeout(() => {
      sendDashboardSnapshot(ws);
    }, 100);
  }

  // Someone joins a PATIENT room - send them that patient's snapshot
  if (room !== "dashboard" && room !== "lobby") {
    if (roomSize > 0) {
      log("INFO", `New viewer joined patient room "${room}", sending snapshot`);
      setTimeout(() => {
        sendCurrentSnapshotToClient(ws, room);
      }, 100);
    }
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

  // Handle patient disconnecting from dashboard
  if (clientId && room === "dashboard" && !clientId.startsWith("staff-")) {
    const snapshot = dashboardSnapshots.get(clientId);

    // Update snapshot status to disconnected
    if (snapshot) {
      dashboardSnapshots.set(clientId, {
        ...snapshot,
        status: "disconnected",
        lastActivity: Date.now(),
      });
    }

    // Notify staff of disconnection immediately
    notifyPatientDisconnected(clientId);

    // Schedule removal after delay (unless already submitted)
    if (!snapshot?.summary?.submitted) {
      schedulePatientRemoval(clientId, "disconnected");
    }
  }

  log(
    "INFO",
    `Client "${clientId || "anonymous"}" disconnected from room "${room}"`
  );
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
  const disconnectedAt = Date.now();
  const disconnectMessage = {
    type: "patientDisconnected",
    clientId: clientId,
    timestamp: disconnectedAt,
    disconnectedAt: disconnectedAt,
  };

  broadcast("dashboard", JSON.stringify(disconnectMessage));
  log("INFO", `❌ Notified dashboard: Patient "${clientId}" disconnected`);
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
  // Store full snapshot for patient rooms (for staff live view)
  if (sourceRoom !== "dashboard" && msg.type === "formSnapshot") {
    const existingSummary = patientSummaries.get(msg.clientId) || {};
    const updatedSummary = {
      ...msg.payload,
      submitted: existingSummary.submitted || msg.payload?.submitted || false,
    };
    patientSummaries.set(msg.clientId, updatedSummary);
    log("INFO", `💾 Updated patient room snapshot for "${msg.clientId}"`);
  
    return;
  }

  // HANDLE SUMMARY MESSAGES FROM DASHBOARD ROOM (patient sending their own summary)
  if (sourceRoom === "dashboard" && msg.type === "summary") {
    const existingDashboardData = dashboardSnapshots.get(msg.clientId) || {};
    const updatedSnapshot = {
      ...existingDashboardData,
      clientId: msg.clientId,
      summary: msg.payload,
      lastActivity: Date.now(),
      status: existingDashboardData.status || "online",
      joinedAt: existingDashboardData.joinedAt || Date.now(),
    };
    
    dashboardSnapshots.set(msg.clientId, updatedSnapshot);
    log("INFO", `💾 Updated dashboard snapshot from dashboard summary for "${msg.clientId}":`, updatedSnapshot);
    
    broadcast("dashboard", JSON.stringify(msg));
    console.log("=== handleFormUpdate END (dashboard summary path) ===");
    return;
  }

  // Don't forward other dashboard messages back to dashboard
  if (sourceRoom === "dashboard") {
    return;
  }
}

function handleStatusUpdate(ws, msg) {
  const { clientId, state } = msg;

  // Update client status in memory
  updateClientStatus(ws, state);

  // UPDATE DASHBOARD SNAPSHOT if this patient is in dashboard
  if (dashboardSnapshots.has(clientId)) {
    const snapshot = dashboardSnapshots.get(clientId);
    dashboardSnapshots.set(clientId, {
      ...snapshot,
      status: state,
      lastActivity: Date.now(),
    });
    log(
      "INFO",
      `💾 Updated status in dashboard snapshot for "${clientId}": ${state}`
    );
  }

  log("INFO", `🔔 Status update from "${clientId}": ${state}`);
}

function handleFormSubmit(msg, sourceRoom) {
  log("INFO", `✅ Form submitted by "${msg.clientId}"`);

  const submittedAt = Date.now();
  const submittedData = {
    ...msg.payload,
    submitted: true,
    submittedAt: submittedAt,
    progress: msg.payload?.progress ?? 100,
  };

  // Store in patient room snapshot
  patientSummaries.set(msg.clientId, submittedData);

  // UPDATE DASHBOARD SNAPSHOT
  const existingDashboardData = dashboardSnapshots.get(msg.clientId) || {};
  dashboardSnapshots.set(msg.clientId, {
    ...existingDashboardData,
    clientId: msg.clientId,
    status: "online",
    lastActivity: submittedAt,
    joinedAt: existingDashboardData.joinedAt || submittedAt,
    summary: {
      firstName: submittedData.firstName || null,
      lastName: submittedData.lastName || null,
      progress: 100,
      submitted: true,
      submittedAt: submittedAt,
    },
  });
  log(
    "INFO",
    `💾 Updated dashboard snapshot with submission for "${msg.clientId}"`
  );

  // Broadcast to patient's room
  if (sourceRoom !== "dashboard") {
    broadcast(sourceRoom, JSON.stringify(msg));
  }

  // Forward to dashboard
  const submitNotification = {
    type: "summary",
    clientId: msg.clientId,
    payload: {
      firstName: submittedData.firstName || null,
      lastName: submittedData.lastName || null,
      progress: 100,
      submitted: true,
      submittedAt: submittedAt,
    },
    timestamp: submittedAt,
  };

  broadcast("dashboard", JSON.stringify(submitNotification));
  log("INFO", `📤 Notified dashboard of submission for "${msg.clientId}"`);

  // Schedule removal from dashboard after delay
  schedulePatientRemoval(msg.clientId, "submitted");
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
  `⚙️  Configuration: Heartbeat=${CONFIG.HEARTBEAT_INTERVAL}ms, Timeout=${CONFIG.CLIENT_TIMEOUT}ms, Removal Delay=${CONFIG.REMOVAL_DELAY}ms`
);

wss.on("connection", (ws, req) => {
  const { room, clientId } = getRoomFromRequest(req);

  log(
    "INFO",
    `🔌 New connection - Room: "${room}", ClientId: "${clientId || "none"}"`
  );

  addClientToRoom(ws, room, clientId);

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
    `📊 Server stats - Rooms: ${rooms.size}, Total clients: ${clients.size}, Dashboard snapshots: ${dashboardSnapshots.size}, Patient snapshots: ${patientSummaries.size}, Pending removals: ${removalTimers.size}`
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

  // Log dashboard snapshots
  if (dashboardSnapshots.size > 0) {
    const snapshotList = Array.from(dashboardSnapshots.entries())
      .map(([id, snap]) => {
        const status = snap.summary?.submitted ? "submitted" : snap.status;
        return `${id.substring(0, 8)}(${status})`;
      })
      .join(", ");
    log("INFO", `   Dashboard snapshots: [${snapshotList}]`);
  }
}, CONFIG.STATS_INTERVAL);

// Failsafe cleanup for very old records (in case timers fail)
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  const CLEANUP_AGE = 120000; // 2 minutes (failsafe)

  dashboardSnapshots.forEach((snapshot, clientId) => {
    const eventTimestamp =
      snapshot.summary?.submittedAt || snapshot.lastActivity;
    if (eventTimestamp && now - eventTimestamp > CLEANUP_AGE) {
      dashboardSnapshots.delete(clientId);
      patientSummaries.delete(clientId);
      if (removalTimers.has(clientId)) {
        clearTimeout(removalTimers.get(clientId));
        removalTimers.delete(clientId);
      }
      log(
        "INFO",
        `🧹 Failsafe cleanup for old patient "${clientId}" (age: ${Math.round(
          (now - eventTimestamp) / 1000
        )}s)`
      );
    }
  });
}, 60000); // Check every minute

// Graceful shutdown handler
function shutdown(signal) {
  log("INFO", `${signal} received - shutting down gracefully...`);

  clearInterval(heartbeatInterval);
  clearInterval(statsInterval);
  clearInterval(cleanupInterval);

  // Clear all removal timers
  removalTimers.forEach((timerId) => clearTimeout(timerId));
  removalTimers.clear();

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
