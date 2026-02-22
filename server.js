/**
 * AthenaX - Signaling Server
 *
 * This server's ONLY job is WebRTC signaling:
 *  - Assign unique, human-readable device IDs to connecting clients
 *  - Maintain and broadcast the list of connected peers
 *  - Relay offer / answer / ICE-candidate messages between peers
 *
 * No files ever pass through this server.
 * All binary data is sent directly peer-to-peer via WebRTC DataChannels.
 */

"use strict";

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const { randomBytes } = require("crypto");

// ─────────────────────────────────────────────────────────────────────────────
// App bootstrap
// ─────────────────────────────────────────────────────────────────────────────

const app = express();
const httpServer = http.createServer(app);

// Allow Socket.IO requests from any origin so the app works behind a CDN /
// reverse proxy that may serve the frontend from a different origin.
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  // Increase the maximum payload size to accommodate large signaling messages.
  maxHttpBufferSize: 1e6, // 1 MB
});

// ─────────────────────────────────────────────────────────────────────────────
// Static file serving
// ─────────────────────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, "public")));

// Catch-all: always serve index.html for any unknown GET route
// (useful if the user navigates directly to a deep link).
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─────────────────────────────────────────────────────────────────────────────
// Peer registry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map<socketId, { id: string, name: string }>
 * Keeps track of every connected client.
 */
const peers = new Map();

/**
 * Adjectives and nouns used to build human-readable device names like
 * "Swift-Falcon-3A".  We avoid generating UUIDs so device names are easier
 * to distinguish in the UI.
 */
const ADJECTIVES = [
  "Swift", "Bold", "Calm", "Dark", "Epic", "Fast", "Glow",
  "Iron", "Jade", "Keen", "Lush", "Mist", "Nova", "Onyx",
  "Pure", "Raze", "Sage", "Teal", "Vast", "Wild",
];
const NOUNS = [
  "Falcon", "Ghost", "Hawk", "Iris", "Jade", "Kite", "Lynx",
  "Mist", "Nexus", "Orb", "Pulse", "Quest", "Raven", "Star",
  "Titan", "Ultra", "Viper", "Wolf", "Xenon", "Zeal",
];

/**
 * Generates a unique, human-readable device name.
 * e.g. "Swift-Falcon-4B"
 */
function generateDeviceName() {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const suffix = randomBytes(1).toString("hex").toUpperCase();
  return `${adj}-${noun}-${suffix}`;
}

/**
 * Returns a serializable snapshot of all connected peers.
 */
function getPeerList() {
  return Array.from(peers.values());
}

// ─────────────────────────────────────────────────────────────────────────────
// Socket.IO event handling
// ─────────────────────────────────────────────────────────────────────────────

io.on("connection", (socket) => {
  // Assign a unique, human-readable name to this device.
  const deviceName = generateDeviceName();
  peers.set(socket.id, { id: socket.id, name: deviceName });

  console.log(`[+] Connected: "${deviceName}" (${socket.id})`);

  // 1. Tell the newcomer its own identity so the UI can display it.
  socket.emit("self-identity", { id: socket.id, name: deviceName });

  // 2. Broadcast the updated peer list to EVERYONE (including the newcomer).
  io.emit("peer-list", getPeerList());

  // ── WebRTC Signaling relay ────────────────────────────────────────────────

  /**
   * A peer wants to establish a connection → sends an SDP offer.
   * We relay it to the target peer (identified by targetId).
   *
   * Payload: { targetId: string, offer: RTCSessionDescriptionInit }
   */
  socket.on("offer", ({ targetId, offer }) => {
    if (!peers.has(targetId)) return; // target has disconnected
    socket.to(targetId).emit("offer", {
      fromId: socket.id,
      fromName: peers.get(socket.id)?.name,
      offer,
    });
  });

  /**
   * The responder sends its SDP answer back to the initiator.
   *
   * Payload: { targetId: string, answer: RTCSessionDescriptionInit }
   */
  socket.on("answer", ({ targetId, answer }) => {
    if (!peers.has(targetId)) return;
    socket.to(targetId).emit("answer", {
      fromId: socket.id,
      answer,
    });
  });

  /**
   * Exchange ICE candidates between peers.
   *
   * Payload: { targetId: string, candidate: RTCIceCandidateInit }
   */
  socket.on("ice-candidate", ({ targetId, candidate }) => {
    if (!peers.has(targetId)) return;
    socket.to(targetId).emit("ice-candidate", {
      fromId: socket.id,
      candidate,
    });
  });

  // ── Disconnect cleanup ─────────────────────────────────────────────────────

  socket.on("disconnect", (reason) => {
    const peer = peers.get(socket.id);
    console.log(`[-] Disconnected: "${peer?.name}" (${socket.id}) — ${reason}`);
    peers.delete(socket.id);

    // Notify remaining peers so they can update their UI.
    io.emit("peer-list", getPeerList());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Start the HTTP server
// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`\nAthenaX signaling server running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} to use the app locally.\n`);
});
