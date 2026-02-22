/**
 * AthenaX – Signaling + File Relay Server (v3)
 *
 * Architecture change from v2:
 *  - WebRTC is REMOVED for data transfer (unreliable without custom TURN)
 *  - File chunks are relayed through Socket.IO in-memory (no disk writes)
 *  - Peers still use Socket.IO for: discovery, mode selection, file transfer
 *
 * Transfer flow:
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
    // Allow chunks up to 256 KB + envelope overhead
    maxHttpBufferSize: 300 * 1024,
});

// ─── Static files ─────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// Catch-all — must come AFTER all API routes
app.get("*", (_req, res) =>
    res.sendFile(path.join(__dirname, "public", "index.html"))
);

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

// ─── Socket.IO ────────────────────────────────────────────────────
io.on("connection", (socket) => {
    const name = generateName();
    peers.set(socket.id, { id: socket.id, name, mode: "none" });
    console.log(`[+] ${name} (${socket.id})`);

    socket.emit("self-identity", { id: socket.id, name });
    broadcastPeerLists();

    // ── Mode selection ──────────────────────────────────────────────
    socket.on("set-mode", (mode) => {
        const peer = peers.get(socket.id);
        if (!peer || (mode !== "sender" && mode !== "receiver")) return;
        peer.mode = mode;
        socket.emit("mode-confirmed", mode);
        broadcastPeerLists();
        console.log(`[~] ${peer.name}: ${mode}`);
    });

    // ── File Transfer Relay ─────────────────────────────────────────

    /**
     * Step 1: Sender announces an incoming transfer to the receiver.
     * Payload: { targetId, meta: { fileName, fileSize, fileType } }
     */
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

    /**
     * Step 2: Relay binary chunk to the receiver.
     * The callback(ack) tells the sender it's safe to send the next chunk
     * (natural ACK-based backpressure — no chunk floods the server).
     *
     * Payload: { targetId, chunk: Buffer, chunkIndex: number }
     */
    socket.on("file-chunk", ({ targetId, chunk, chunkIndex }, ack) => {
        if (!peers.has(targetId)) {
            if (typeof ack === "function") ack("no-peer");
            return;
        }
        // Forward the raw chunk to the receiver
        io.to(targetId).emit("file-chunk", { chunk, chunkIndex });
        // ACK back to sender — triggers the next chunk read
        if (typeof ack === "function") ack("ok");
    });

    /**
     * Step 3: Signal to the receiver that all chunks have been sent.
     */
    socket.on("transfer-done", ({ targetId }) => {
        if (!peers.has(targetId)) return;
        io.to(targetId).emit("transfer-done");
    });

    /**
     * Sender cancelled mid-transfer.
     */
    socket.on("transfer-cancel", ({ targetId }) => {
        if (!peers.has(targetId)) return;
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
    console.log(`\nAthenaX v3 | Socket.IO relay | port ${PORT}`);
    console.log(`Local: http://localhost:${PORT}\n`);
});
