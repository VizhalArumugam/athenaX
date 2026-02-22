/**
 * AthenaX – Signaling Server (v2)
 *
 * New in v2:
 *  - Tracks each peer's mode: "none" | "sender" | "receiver"
 *  - When a client sets its mode, the peer list broadcast is filtered:
 *      → Senders see only receivers
 *      → Receivers see nothing (they wait)
 *  - All WebRTC relay logic (offer/answer/ICE) unchanged
 */

"use strict";

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const { randomBytes } = require("crypto");

// ─── App bootstrap ────────────────────────────────────────────────
const app = express();
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    maxHttpBufferSize: 1e6,
});

// ─── Static files ─────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// ─── ICE server config endpoint ───────────────────────────────────
/**
 * GET /api/ice-servers
 *
 * Returns the RTCConfiguration.iceServers array to the client.
 * Credentials are kept server-side so they are NEVER exposed in
 * the public JavaScript bundle.
 *
 * Supports two TURN providers (configure via Render env vars):
 *
 * ── Option A: Metered.ca (recommended free TURN) ──────────────────
 *   METERED_API_KEY  = your Metered app API key
 *   METERED_APP_NAME = your Metered app hostname  (e.g. "athenax")
 *   → credentials are fetched live from Metered's API
 *
 * ── Option B: Manual TURN credentials ─────────────────────────────
 *   TURN_URL        = turn:your-turn-server.com:3478
 *   TURN_USERNAME   = your-username
 *   TURN_CREDENTIAL = your-credential
 */
app.get("/api/ice-servers", async (req, res) => {
    const iceServers = [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun2.l.google.com:19302" },
    ];

    // ── Option A: Metered.ca ─────────────────────────────────────
    const meteredKey = process.env.METERED_API_KEY;
    const meteredName = process.env.METERED_APP_NAME;

    if (meteredKey && meteredName) {
        try {
            const url = `https://${meteredName}.metered.ca/api/v1/turn/credentials?apiKey=${meteredKey}`;
            const resp = await fetch(url);
            if (resp.ok) {
                const turnServers = await resp.json();
                iceServers.push(...turnServers);
                console.log(`[ICE] Metered TURN: loaded ${turnServers.length} servers`);
            } else {
                console.error(`[ICE] Metered API returned ${resp.status}`);
            }
        } catch (e) {
            console.error("[ICE] Could not reach Metered API:", e.message);
        }
    }

    // ── Option B: Manual TURN env vars ───────────────────────────
    const turnUrl = process.env.TURN_URL;
    const turnUser = process.env.TURN_USERNAME;
    const turnCred = process.env.TURN_CREDENTIAL;

    if (turnUrl && turnUser && turnCred) {
        iceServers.push({ urls: turnUrl, username: turnUser, credential: turnCred });
        iceServers.push({ urls: turnUrl + "?transport=tcp", username: turnUser, credential: turnCred });
        console.log("[ICE] Manual TURN server added:", turnUrl);
    }

    if (iceServers.length === 3) {
        // Only STUN — warn that TURN is not configured
        console.warn("[ICE] WARNING: No TURN server configured. Cross-network transfers will fail.");
    }

    res.json({ iceServers });
});

// Catch-all — must come AFTER all API routes
app.get("*", (_req, res) =>
    res.sendFile(path.join(__dirname, "public", "index.html"))
);

// ─── Peer registry ────────────────────────────────────────────────
/** Map<socketId, { id, name, mode: "none"|"sender"|"receiver" }> */
const peers = new Map();

const ADJECTIVES = ["Swift", "Bold", "Calm", "Dark", "Epic", "Fast", "Glow", "Iron", "Jade", "Keen", "Lush", "Mist", "Nova", "Onyx", "Pure", "Sage", "Teal", "Vast", "Wild", "Zeal"];
const NOUNS = ["Falcon", "Ghost", "Hawk", "Iris", "Kite", "Lynx", "Nexus", "Orb", "Pulse", "Raven", "Star", "Titan", "Viper", "Wolf", "Xenon", "Blaze", "Cruz", "Dart", "Edge", "Flux"];

function generateDeviceName() {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
    const suffix = randomBytes(1).toString("hex").toUpperCase();
    return `${adj}-${noun}-${suffix}`;
}

/**
 * Build the peer list that a specific socket should see.
 *  - Senders see all receivers (mode === "receiver")
 *  - Everyone else sees an empty list (they haven't picked a mode yet,
 *    or they are a receiver waiting passively)
 */
function getPeerListFor(socketId) {
    const self = peers.get(socketId);
    if (!self || self.mode !== "sender") return [];
    return Array.from(peers.values()).filter(
        (p) => p.id !== socketId && p.mode === "receiver"
    );
}

/** Broadcast updated peer lists to every connected client. */
function broadcastPeerLists() {
    for (const [socketId] of peers) {
        io.to(socketId).emit("peer-list", getPeerListFor(socketId));
    }
}

// ─── Socket.IO events ─────────────────────────────────────────────
io.on("connection", (socket) => {
    const name = generateDeviceName();
    peers.set(socket.id, { id: socket.id, name, mode: "none" });

    console.log(`[+] ${name} (${socket.id})`);

    // Tell the client its own identity
    socket.emit("self-identity", { id: socket.id, name });

    // Broadcast updated lists (new peer hasn't chosen a mode yet — no list change visible to others)
    broadcastPeerLists();

    // ── Mode selection ──────────────────────────────────────────────
    // Client emits this when the user clicks Send or Receive
    socket.on("set-mode", (mode) => {
        const peer = peers.get(socket.id);
        if (!peer) return;
        if (mode !== "sender" && mode !== "receiver") return;

        peer.mode = mode;
        console.log(`[~] ${peer.name} set mode: ${mode}`);

        // Tell the client its confirmed mode
        socket.emit("mode-confirmed", mode);

        // Rebroadcast lists — a new receiver may now appear for senders
        broadcastPeerLists();
    });

    // ── WebRTC Signaling relay ──────────────────────────────────────

    socket.on("offer", ({ targetId, offer }) => {
        if (!peers.has(targetId)) return;
        const from = peers.get(socket.id);
        socket.to(targetId).emit("offer", {
            fromId: socket.id,
            fromName: from?.name ?? "Unknown",
            offer,
        });
    });

    socket.on("answer", ({ targetId, answer }) => {
        if (!peers.has(targetId)) return;
        socket.to(targetId).emit("answer", { fromId: socket.id, answer });
    });

    socket.on("ice-candidate", ({ targetId, candidate }) => {
        if (!peers.has(targetId)) return;
        socket.to(targetId).emit("ice-candidate", { fromId: socket.id, candidate });
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
    console.log(`\nAthenaX v2 signaling server on port ${PORT}`);
    console.log(`Local: http://localhost:${PORT}\n`);
});
