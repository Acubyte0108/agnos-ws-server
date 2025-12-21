import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage } from "http";

// ============================================================================
// Type Definitions
// ============================================================================

type Config = {
  PORT: number;
  HEARTBEAT_INTERVAL: number;
  CLIENT_TIMEOUT: number;
  STATS_INTERVAL: number;
  REMOVAL_DELAY: number;
}

type ClientInfo = {
  ws: WebSocket;
  room: string;
  clientId: string;
  joinedAt: number;
  lastActivity: number;
  status: "online" | "idle" | "updating" | "disconnected";
}

type PatientFormData = {
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string;
  gender?: string;
  phone?: string;
  email?: string;
  address?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  country?: string;
  preferredLanguage?: string;
  nationality?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  emergencyContactRelation?: string;
  medicalHistory?: string;
  currentMedications?: string;
  allergies?: string;
  insuranceProvider?: string;
  insurancePolicyNumber?: string;
  submitted?: boolean;
  submittedAt?: number;
  progress?: number;
  [key: string]: any; // Allow additional fields
}

type PatientSummary = {
  firstName?: string | null;
  lastName?: string | null;
  progress?: number;
  submitted?: boolean;
  submittedAt?: number;
}

type DashboardPatientInfo = {
  clientId: string;
  status: "online" | "idle" | "updating" | "disconnected";
  joinedAt: number;
  lastActivity: number;
  summary: PatientSummary;
}

type WebSocketMessage = {
  type: string;
  clientId: string;
  payload?: any;
  state?: string;
  timestamp?: number;
}

type LogLevel = "INFO" | "WARN" | "ERROR";

// ============================================================================
// Map Type Definitions
// ============================================================================

type Rooms = Map<string, Set<WebSocket>>;
type Clients = Map<WebSocket, ClientInfo>;
type PatientSummaries = Map<string, PatientFormData>;
type DashboardSnapshots = Map<string, DashboardPatientInfo>;
type RemovalTimers = Map<string, NodeJS.Timeout>;

// ============================================================================
// Configuration
// ============================================================================

const CONFIG: Config = {
  PORT: process.env.PORT ? Number(process.env.PORT) : 4000,
  HEARTBEAT_INTERVAL: 30000,
  CLIENT_TIMEOUT: 60000,
  STATS_INTERVAL: 60000,
  REMOVAL_DELAY: 20000,
};

// ============================================================================
// State Maps
// ============================================================================

const rooms: Rooms = new Map();
const clients: Clients = new Map();
const patientSummaries: PatientSummaries = new Map();
const dashboardSnapshots: DashboardSnapshots = new Map();
const removalTimers: RemovalTimers = new Map();

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Logs messages with timestamp and level
 */
function log(level: LogLevel, message: string, ...args: any[]): void {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}]`, message, ...args);
}

/**
 * Parses and validates incoming WebSocket messages
 * Returns null if message is invalid
 */
function parseMessage(data: any): WebSocketMessage | null {
  try {
    const raw = typeof data === "string" ? data : data.toString();
    const msg = JSON.parse(raw) as WebSocketMessage;

    if (!msg.type || !msg.clientId) {
      log("WARN", "Invalid message - missing type or clientId");
      return null;
    }

    return msg;
  } catch (err) {
    log("ERROR", "Failed to parse message:", err);
    return null;
  }
}

/**
 * Broadcasts a message to all clients in a room (except sender)
 */
function broadcast(roomId: string, message: string, except?: WebSocket): void {
  const roomClients = rooms.get(roomId);
  if (!roomClients) return;

  let sentCount = 0;
  for (const client of roomClients) {
    if (client !== except && client.readyState === WebSocket.OPEN) {
      try {
        client.send(message);
        sentCount++;
      } catch (err) {
        log("ERROR", `Broadcast failed in room ${roomId}:`, err);
      }
    }
  }
}

/**
 * Sends the current patient form snapshot and status to a new viewer
 * Called when staff joins a patient's individual room
 */
function sendCurrentSnapshotToClient(ws: WebSocket, patientId: string): void {
  const summary = patientSummaries.get(patientId);
  const dashboardData = dashboardSnapshots.get(patientId);

  if (!summary && !dashboardData) return;

  try {
    if (summary) {
      ws.send(
        JSON.stringify({
          type: "formSnapshot",
          clientId: patientId,
          payload: summary,
          timestamp: Date.now(),
        })
      );
    }

    if (dashboardData?.status) {
      ws.send(
        JSON.stringify({
          type: "status",
          clientId: patientId,
          state: dashboardData.status,
          timestamp: Date.now(),
        })
      );
    }
  } catch (err) {
    log("ERROR", "Failed to send snapshot:", err);
  }
}

/**
 * Sends the complete list of active patients to staff joining dashboard
 * Includes all patient summaries, statuses, and metadata
 */
function sendDashboardSnapshot(staffWs: WebSocket): void {
  const activePatients = Array.from(dashboardSnapshots.values());

  if (activePatients.length === 0) return;

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
}

/**
 * Schedules a patient to be removed from dashboard after configured delay
 * Used for disconnected or submitted patients (20 second fade-out period)
 */
function schedulePatientRemoval(clientId: string, reason: string): void {
  if (removalTimers.has(clientId)) {
    clearTimeout(removalTimers.get(clientId)!);
  }

  const timerId = setTimeout(() => {
    dashboardSnapshots.delete(clientId);
    patientSummaries.delete(clientId);
    removalTimers.delete(clientId);

    broadcast(
      "dashboard",
      JSON.stringify({
        type: "patientRemoved",
        clientId,
        timestamp: Date.now(),
      })
    );

    log("INFO", `Removed ${reason} patient: ${clientId}`);
  }, CONFIG.REMOVAL_DELAY);

  removalTimers.set(clientId, timerId);
}

/**
 * Adds a client to a room and initializes their session
 * Handles different logic for patients vs staff, dashboard vs individual rooms
 */
function addClientToRoom(ws: WebSocket, room: string, clientId: string): void {
  if (!rooms.has(room)) {
    rooms.set(room, new Set());
  }

  const roomSize = rooms.get(room)!.size;
  rooms.get(room)!.add(ws);

  clients.set(ws, {
    ws,
    room,
    clientId,
    joinedAt: Date.now(),
    lastActivity: Date.now(),
    status: "online",
  });

  // Patient joining dashboard: create/restore their snapshot
  if (clientId && room === "dashboard" && !clientId.startsWith("staff-")) {
    if (removalTimers.has(clientId)) {
      clearTimeout(removalTimers.get(clientId)!);
      removalTimers.delete(clientId);
    }

    const existingSnapshot = dashboardSnapshots.get(clientId);
    const patientData = patientSummaries.get(clientId);

    // Preserve existing summary data or use patient room data
    let summary: PatientSummary = {};
    if (
      existingSnapshot?.summary &&
      Object.keys(existingSnapshot.summary).length > 0
    ) {
      summary = existingSnapshot.summary;
    } else if (patientData) {
      summary = {
        firstName: patientData.firstName || null,
        lastName: patientData.lastName || null,
        progress: patientData.progress || 0,
        submitted: patientData.submitted || false,
      };
    }

    dashboardSnapshots.set(clientId, {
      ...existingSnapshot,
      clientId,
      status: "online",
      joinedAt: existingSnapshot?.joinedAt || Date.now(),
      lastActivity: Date.now(),
      summary,
    } as DashboardPatientInfo);

    notifyPatientConnected(clientId);
  }

  // Staff joining dashboard: send them all patient data
  if (clientId && room === "dashboard" && clientId.startsWith("staff-")) {
    setTimeout(() => sendDashboardSnapshot(ws), 100);
  }

  // Staff joining patient room: send them that patient's current data
  if (room !== "dashboard" && room !== "lobby" && roomSize > 0) {
    setTimeout(() => sendCurrentSnapshotToClient(ws, room), 100);
  }
}

/**
 * Removes a client from their room and handles cleanup
 * For patients: updates status to disconnected and schedules removal
 */
function removeClientFromRoom(ws: WebSocket): void {
  const clientInfo = clients.get(ws);
  if (!clientInfo) return;

  const { room, clientId } = clientInfo;
  const roomClients = rooms.get(room);

  if (roomClients) {
    roomClients.delete(ws);
    if (roomClients.size === 0) {
      rooms.delete(room);
    }
  }

  clients.delete(ws);

  // Patient disconnecting from dashboard
  if (clientId && room === "dashboard" && !clientId.startsWith("staff-")) {
    const snapshot = dashboardSnapshots.get(clientId);

    if (snapshot) {
      dashboardSnapshots.set(clientId, {
        ...snapshot,
        status: "disconnected",
        lastActivity: Date.now(),
      });
    }

    // Notify dashboard room
    notifyPatientDisconnected(clientId);

    // Notify patient's individual room (for live viewers)
    broadcast(
      clientId,
      JSON.stringify({
        type: "status",
        clientId,
        state: "disconnected",
        timestamp: Date.now(),
      })
    );

    // Schedule removal unless already submitted
    if (!snapshot?.summary?.submitted) {
      schedulePatientRemoval(clientId, "disconnected");
    }
  }
}

/**
 * Updates the last activity timestamp for a client
 * Used for heartbeat tracking and timeout detection
 */
function updateClientActivity(ws: WebSocket): void {
  const clientInfo = clients.get(ws);
  if (clientInfo) {
    clientInfo.lastActivity = Date.now();
  }
}

/**
 * Updates a client's status (online, idle, updating, disconnected)
 */
function updateClientStatus(
  ws: WebSocket,
  status: ClientInfo["status"]
): void {
  const clientInfo = clients.get(ws);
  if (clientInfo) {
    clientInfo.status = status;
  }
}

/**
 * Notifies dashboard that a patient has connected
 */
function notifyPatientConnected(clientId: string): void {
  broadcast(
    "dashboard",
    JSON.stringify({
      type: "patientConnected",
      clientId,
      timestamp: Date.now(),
    })
  );
}

/**
 * Notifies dashboard that a patient has disconnected
 */
function notifyPatientDisconnected(clientId: string): void {
  const disconnectedAt = Date.now();
  broadcast(
    "dashboard",
    JSON.stringify({
      type: "patientDisconnected",
      clientId,
      timestamp: disconnectedAt,
      disconnectedAt,
    })
  );
}

// ============================================================================
// Message Handlers
// ============================================================================

/**
 * Main message handler - routes messages to appropriate handlers
 * Also broadcasts messages to other clients in the same room
 */
function handleMessage(ws: WebSocket, data: any): void {
  const msg = parseMessage(data);
  if (!msg) return;

  updateClientActivity(ws);

  const clientInfo = clients.get(ws);
  if (!clientInfo) return;

  const { room } = clientInfo;

  // Broadcast to room (except sender)
  broadcast(room, JSON.stringify(msg), ws);

  // Route to specific handler
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
  }
}

/**
 * Handles form update messages (summary and full snapshots)
 * - formSnapshot: stores complete form data for patient rooms
 * - summary: updates dashboard with patient name and progress
 */
function handleFormUpdate(msg: WebSocketMessage, sourceRoom: string): void {
  // Store full snapshot for patient rooms (for staff live view)
  if (sourceRoom !== "dashboard" && msg.type === "formSnapshot") {
    const existingSummary = patientSummaries.get(msg.clientId) || {};
    patientSummaries.set(msg.clientId, {
      ...msg.payload,
      submitted:
        existingSummary.submitted || msg.payload?.submitted || false,
    });
    return;
  }

  // Update dashboard snapshot from summary messages
  if (sourceRoom === "dashboard" && msg.type === "summary") {
    const existingData = dashboardSnapshots.get(msg.clientId) || {} as DashboardPatientInfo;
    dashboardSnapshots.set(msg.clientId, {
      ...existingData,
      clientId: msg.clientId,
      summary: msg.payload,
      lastActivity: Date.now(),
      status: existingData.status || "online",
      joinedAt: existingData.joinedAt || Date.now(),
    } as DashboardPatientInfo);
    broadcast("dashboard", JSON.stringify(msg));
    return;
  }
}

/**
 * Handles status update messages (online, idle, updating, disconnected)
 * Updates both client metadata and dashboard snapshot
 */
function handleStatusUpdate(ws: WebSocket, msg: WebSocketMessage): void {
  const { clientId, state } = msg;

  if (state && isValidStatus(state)) {
    updateClientStatus(ws, state as ClientInfo["status"]);

    if (dashboardSnapshots.has(clientId)) {
      const snapshot = dashboardSnapshots.get(clientId)!;
      dashboardSnapshots.set(clientId, {
        ...snapshot,
        status: state as ClientInfo["status"],
        lastActivity: Date.now(),
      });
    }
  }
}

/**
 * Type guard to check if a string is a valid status
 */
function isValidStatus(
  status: string
): status is ClientInfo["status"] {
  return ["online", "idle", "updating", "disconnected"].includes(status);
}

/**
 * Handles form submission
 * Updates both patient room and dashboard, then schedules removal
 */
function handleFormSubmit(msg: WebSocketMessage, sourceRoom: string): void {
  const submittedAt = Date.now();
  const submittedData: PatientFormData = {
    ...msg.payload,
    submitted: true,
    submittedAt,
    progress: msg.payload?.progress ?? 100,
  };

  // Store in patient room
  patientSummaries.set(msg.clientId, submittedData);

  // Update dashboard snapshot
  const existingData = dashboardSnapshots.get(msg.clientId) || {} as DashboardPatientInfo;
  dashboardSnapshots.set(msg.clientId, {
    ...existingData,
    clientId: msg.clientId,
    status: "online",
    lastActivity: submittedAt,
    joinedAt: existingData.joinedAt || submittedAt,
    summary: {
      firstName: submittedData.firstName || null,
      lastName: submittedData.lastName || null,
      progress: 100,
      submitted: true,
      submittedAt,
    },
  } as DashboardPatientInfo);

  // Broadcast to patient room
  if (sourceRoom !== "dashboard") {
    broadcast(sourceRoom, JSON.stringify(msg));
  }

  // Notify dashboard
  broadcast(
    "dashboard",
    JSON.stringify({
      type: "summary",
      clientId: msg.clientId,
      payload: {
        firstName: submittedData.firstName || null,
        lastName: submittedData.lastName || null,
        progress: 100,
        submitted: true,
        submittedAt,
      },
      timestamp: submittedAt,
    })
  );

  schedulePatientRemoval(msg.clientId, "submitted");
  log("INFO", `Form submitted: ${msg.clientId}`);
}

// ============================================================================
// Connection Management
// ============================================================================

/**
 * Sets up periodic heartbeat to detect stale connections
 * Pings clients every 30s, terminates if no response for 60s
 */
function setupHeartbeat(): NodeJS.Timeout {
  const interval = setInterval(() => {
    const now = Date.now();

    clients.forEach((clientInfo, ws) => {
      if (now - clientInfo.lastActivity > CONFIG.CLIENT_TIMEOUT) {
        log("WARN", `Client timeout: ${clientInfo.clientId}`);
        ws.terminate();
        return;
      }

      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
        } catch (err) {
          log("ERROR", `Ping failed for ${clientInfo.clientId}:`, err);
        }
      }
    });
  }, CONFIG.HEARTBEAT_INTERVAL);

  return interval;
}

/**
 * Extracts room and clientId from WebSocket connection request URL
 */
function getRoomFromRequest(req: IncomingMessage): {
  room: string;
  clientId: string | undefined;
} {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  return {
    room: url.searchParams.get("room") || "lobby",
    clientId: url.searchParams.get("clientId") || undefined,
  };
}

// ============================================================================
// Server Initialization
// ============================================================================

const wss = new WebSocketServer({ port: CONFIG.PORT });

log("INFO", `🚀 WebSocket server started on port ${CONFIG.PORT}`);

wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  const { room, clientId } = getRoomFromRequest(req);

  if (!clientId) {
    ws.close(1008, "Missing clientId");
    return;
  }

  addClientToRoom(ws, room, clientId);

  ws.on("message", (data) => handleMessage(ws, data));
  ws.on("pong", () => updateClientActivity(ws));
  ws.on("error", (error) => {
    const clientInfo = clients.get(ws);
    log("ERROR", `WebSocket error for ${clientInfo?.clientId}:`, error.message);
  });
  ws.on("close", () => removeClientFromRoom(ws));

  // Send welcome message
  try {
    ws.send(
      JSON.stringify({
        type: "connected",
        clientId: clientId || "anonymous",
        room,
        timestamp: Date.now(),
      })
    );
  } catch (err) {
    log("ERROR", "Failed to send welcome message:", err);
  }
});

// ============================================================================
// Background Tasks
// ============================================================================

const heartbeatInterval = setupHeartbeat();

// Periodic stats logging
const statsInterval = setInterval(() => {
  const staffCount = Array.from(clients.values()).filter((c) =>
    c.clientId?.startsWith("staff-")
  ).length;
  log(
    "INFO",
    `📊 Rooms: ${rooms.size}, Clients: ${clients.size}, Staff: ${staffCount}, Patients: ${dashboardSnapshots.size}`
  );
}, CONFIG.STATS_INTERVAL);

// Failsafe cleanup for very old records
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  const CLEANUP_AGE = 120000;

  dashboardSnapshots.forEach((snapshot, clientId) => {
    const eventTimestamp =
      snapshot.summary?.submittedAt || snapshot.lastActivity;
    if (eventTimestamp && now - eventTimestamp > CLEANUP_AGE) {
      dashboardSnapshots.delete(clientId);
      patientSummaries.delete(clientId);
      if (removalTimers.has(clientId)) {
        clearTimeout(removalTimers.get(clientId)!);
        removalTimers.delete(clientId);
      }
    }
  });
}, 60000);

// ============================================================================
// Graceful Shutdown
// ============================================================================

/**
 * Handles graceful server shutdown
 * Clears intervals, notifies clients, and closes connections
 */
function shutdown(signal: string): void {
  log("INFO", `${signal} - shutting down...`);

  clearInterval(heartbeatInterval);
  clearInterval(statsInterval);
  clearInterval(cleanupInterval);

  removalTimers.forEach((timerId) => clearTimeout(timerId));
  removalTimers.clear();

  wss.clients.forEach((ws) => {
    try {
      ws.send(
        JSON.stringify({
          type: "serverShutdown",
          timestamp: Date.now(),
        })
      );
    } catch (err) {
      // Ignore errors when notifying
    }
    ws.close(1000, "Server shutting down");
  });

  wss.close(() => {
    log("INFO", "✅ Server closed");
    process.exit(0);
  });

  setTimeout(() => {
    log("ERROR", "⚠️ Forced shutdown");
    process.exit(1);
  }, 5000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (err) => {
  log("ERROR", "Uncaught exception:", err);
  shutdown("UNCAUGHT_EXCEPTION");
});
process.on("unhandledRejection", (reason, promise) => {
  log("ERROR", "Unhandled rejection:", reason);
});

log("INFO", "✅ Server initialization complete");