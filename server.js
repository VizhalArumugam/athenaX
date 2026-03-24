/**
 * AthenaX v4 – Server (Express + REST API + Socket.IO File Relay)
 *
 * Architecture:
 *  - Express serves the React production build (client/dist/)
 *  - REST API: /api/health, /api/rooms, /api/stats
 *  - Socket.IO: real-time peer discovery + in-memory file chunk relay
 *
 * Transfer flow (unchanged from v3):
 *  Sender → [transfer-request]  → Server → Receiver  (metadata handshake)
 *  Sender → [file-chunk + ACK]  → Server → Receiver  (binary chunks, ACK-gated)
 *  Sender → [transfer-done]     → Server → Receiver  (end signal)
 *
 * Security: chunks pass through memory only and are never written to disk.
 */

"use strict";

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const { randomBytes } = require("crypto");

// ─── Bootstrap ────────────────────────────────────────────────────
const app = express();
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    // Allow chunks up to 2 MB + Socket.IO envelope overhead
    maxHttpBufferSize: 3 * 1024 * 1024,
});

app.use(express.json());

// ─── Peer registry ────────────────────────────────────────────────
/** Map<socketId, { id, name, mode: "none"|"sender"|"receiver" }> */
const peers = new Map();

const ADJECTIVES = ["Swift", "Bold", "Calm", "Dark", "Epic", "Fast", "Glow", "Iron", "Jade", "Keen", "Lush", "Mist", "Nova", "Onyx", "Pure", "Sage", "Teal", "Vast", "Wild", "Zeal"];
const NOUNS = ["Falcon", "Ghost", "Hawk", "Iris", "Kite", "Lynx", "Nexus", "Orb", "Pulse", "Raven", "Star", "Titan", "Viper", "Wolf", "Xenon", "Blaze", "Cruz", "Dart", "Edge", "Flux"];

function generateName() {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
    const suffix = randomBytes(1).toString("hex").toUpperCase();
    return `${adj}-${noun}-${suffix}`;
}

// ─── Server Stats ─────────────────────────────────────────────────
const serverStartTime = Date.now();
let totalTransfers = 0;
let totalBytesRelayed = 0;

// ─── Room Registry ────────────────────────────────────────────────
/** Map<code, { code, createdAt, creatorName }> */
const rooms = new Map();

function generateRoomCode() {
    return randomBytes(3).toString("hex").toUpperCase().slice(0, 6);
}

// ═══════════════════════════════════════════════════════════════════
// REST API
// ═══════════════════════════════════════════════════════════════════

/**
 * GET /api/health — Server health check
 */
app.get("/api/health", (_req, res) => {
    res.json({
        status: "ok",
        uptime: Math.floor((Date.now() - serverStartTime) / 1000),
        connectedPeers: peers.size,
        version: "4.0.0",
    });
});

/**
 * POST /api/rooms — Create a private transfer room
 */
app.post("/api/rooms", (req, res) => {
    const code = generateRoomCode();
    const room = {
        code,
        createdAt: new Date().toISOString(),
        creatorName: req.body?.name || "Anonymous",
    };
    rooms.set(code, room);
    // Auto-expire rooms after 30 minutes
    setTimeout(() => rooms.delete(code), 30 * 60 * 1000);
    res.status(201).json(room);
});

/**
 * GET /api/rooms/:code — Validate a room code
 */
app.get("/api/rooms/:code", (req, res) => {
    const room = rooms.get(req.params.code.toUpperCase());
    if (!room) {
        return res.status(404).json({ exists: false, error: "Room not found" });
    }
    res.json({ exists: true, room });
});

/**
 * GET /api/stats — Server statistics
 */
app.get("/api/stats", (_req, res) => {
    res.json({
        totalTransfers,
        totalBytesRelayed,
        activePeers: peers.size,
        activeSenders: Array.from(peers.values()).filter((p) => p.mode === "sender").length,
        activeReceivers: Array.from(peers.values()).filter((p) => p.mode === "receiver").length,
        activeRooms: rooms.size,
        uptimeSeconds: Math.floor((Date.now() - serverStartTime) / 1000),
    });
});

// ─── Static files (React production build) ────────────────────────
app.use(express.static(path.join(__dirname, "client", "dist")));

// Catch-all — must come AFTER all API routes (serves React index.html)
app.get("*", (_req, res) =>
    res.sendFile(path.join(__dirname, "client", "dist", "index.html"))
);

// ═══════════════════════════════════════════════════════════════════
// Socket.IO — Peer Discovery + File Relay
// ═══════════════════════════════════════════════════════════════════

/** Senders see all receivers; everyone else sees nothing. */
function getPeerListFor(socketId) {
    const self = peers.get(socketId);
    if (!self || self.mode !== "sender") return [];
    return Array.from(peers.values()).filter(
        (p) => p.id !== socketId && p.mode === "receiver"
    );
}

function broadcastPeerLists() {
    for (const [socketId] of peers) {
        io.to(socketId).emit("peer-list", getPeerListFor(socketId));
    }
}

io.on("connection", (socket) => {
    const name = generateName();
    peers.set(socket.id, { id: socket.id, name, mode: "none" });
    console.log(`[+] ${name} (${socket.id})`);

    socket.emit("self-identity", { id: socket.id, name });
    broadcastPeerLists();

    // ── Mode selection ──────────────────────────────────────────────
    socket.on("set-mode", (mode) => {
        const peer = peers.get(socket.id);
        if (!peer || (mode !== "sender" && mode !== "receiver" && mode !== "none")) return;
        peer.mode = mode;
        socket.emit("mode-confirmed", mode);
        broadcastPeerLists();
        console.log(`[~] ${peer.name}: ${mode}`);
    });

    // ── File Transfer Relay ─────────────────────────────────────────

    socket.on("transfer-request", ({ targetId, meta }) => {
        if (!peers.has(targetId)) return;
        const from = peers.get(socket.id);
        socket.to(targetId).emit("transfer-incoming", {
            fromId: socket.id,
            fromName: from?.name ?? "Unknown",
            meta,
        });
        console.log(`[→] Transfer: ${from?.name} → ${peers.get(targetId)?.name}: "${meta.fileName}" (${meta.fileSize} B)`);
    });

    socket.on("file-chunk", ({ targetId, chunk, chunkIndex }, ack) => {
        if (!peers.has(targetId)) {
            if (typeof ack === "function") ack("no-peer");
            return;
        }
        io.to(targetId).emit("file-chunk", { chunk, chunkIndex });
        // Track bytes for stats
        totalBytesRelayed += chunk.byteLength || 0;
        if (typeof ack === "function") ack("ok");
    });

    socket.on("transfer-done", ({ targetId }) => {
        if (!peers.has(targetId)) return;
        io.to(targetId).emit("transfer-done");
        totalTransfers++;
    });

    socket.on("transfer-cancel", ({ targetId }) => {
        if (!targetId || !peers.has(targetId)) return;
        io.to(targetId).emit("transfer-cancel");
    });

    // ── Disconnect ──────────────────────────────────────────────────
    socket.on("disconnect", (reason) => {
        const peer = peers.get(socket.id);
        console.log(`[-] ${peer?.name} (${socket.id}) — ${reason}`);
        peers.delete(socket.id);
        broadcastPeerLists();
    });
});

// ─── Start ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`\nAthenaX v4 | React + REST API + Socket.IO relay | port ${PORT}`);
    console.log(`Local: http://localhost:${PORT}\n`);
});
