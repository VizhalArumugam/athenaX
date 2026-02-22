/**
 * AthenaX v2 – Frontend Application
 *
 * New in v2:
 *  1. Mode selection: user taps Send or Receive before anything happens
 *  2. Sender sees only peers in "receiver" mode
 *  3. Receiver auto-accepts incoming connections (no modal needed — they chose it)
 *  4. Received files are shown in a gallery with inline previews & download
 *  5. Lightbox for full-screen image/video/PDF/text previews
 *  6. Improved ICE candidate buffering for production reliability
 */

"use strict";

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────
const CHUNK_SIZE = 16384;          // 16 KB
const HIGH_WATERMARK = 1 * 1024 * 1024; // 1 MB — pause if bufferedAmount exceeds this
const LOW_WATERMARK = 256 * 1024;     // 256 KB — resume on bufferedamountlow

// ICE configuration is fetched from the server at connection time.
// This keeps TURN credentials out of the public JS bundle.
let ICE_CONFIG = null;

/**
 * Fetch ICE server config from our own server endpoint.
 * Falls back to STUN-only if the server is unreachable.
 * Result is cached after first successful fetch.
 */
async function getIceConfig() {
    if (ICE_CONFIG) return ICE_CONFIG; // use cached copy

    try {
        const res = await fetch("/api/ice-servers");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        ICE_CONFIG = await res.json();
        console.log("[ICE] Config loaded:", ICE_CONFIG.iceServers.length, "servers");
    } catch (e) {
        console.warn("[ICE] Could not fetch config — falling back to STUN only:", e.message);
        ICE_CONFIG = {
            iceServers: [
                { urls: "stun:stun.l.google.com:19302" },
                { urls: "stun:stun1.l.google.com:19302" },
            ],
        };
    }
    return ICE_CONFIG;
}


// ──────────────────────────────────────────────────────────────────────────────
// State
// ──────────────────────────────────────────────────────────────────────────────
let socket = null;
let myId = null;
let myName = null;
let myMode = null; // "sender" | "receiver"

let selectedPeerId = null;
let selectedPeerName = null;

let peerConnection = null;
let dataChannel = null;
let pendingCandidates = [];

let selectedFile = null;
let isBusy = false;

// Sender speed tracking
let sendStartTime = 0;
let bytesSent = 0;

// Receiver state
const rx = {
    active: false,
    meta: null,
    chunks: [],
    received: 0,
    startTime: 0,
};

// Received file gallery
const receivedFiles = []; // [{name, size, type, url, timestamp}]

// ──────────────────────────────────────────────────────────────────────────────
// DOM helpers
// ──────────────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const el = {
    // Shared
    selfName: $("self-name"),
    statusDot: $("status-dot"),
    statusText: $("status-text"),

    // Screens
    modeScreen: $("mode-screen"),
    appMain: $("app-main"),
    senderView: $("sender-view"),
    receiverView: $("receiver-view"),

    // Mode buttons
    modeSend: $("mode-send"),
    modeReceive: $("mode-receive"),
    btnChangeSend: $("btn-change-mode-send"),
    btnChangeRecv: $("btn-change-mode-recv"),

    // Sender — peers
    peerList: $("peer-list"),
    peerCount: $("peer-count"),
    peerHint: $("peer-hint"),

    // Sender — transfer
    selectedPeerName: $("selected-peer-name"),
    dropZone: $("drop-zone"),
    fileInput: $("file-input"),
    dropFileName: $("drop-file-name"),
    btnSend: $("btn-send"),
    progressSection: $("progress-section"),
    progressLabel: $("progress-label"),
    progressPercent: $("progress-percent"),
    progressBar: $("progress-bar"),
    progressTrack: $("progress-track"),
    progressBytes: $("progress-bytes"),
    progressSpeed: $("progress-speed"),
    statusLog: $("status-log"),

    // Receiver
    receiverNameBadge: $("receiver-name-badge"),
    recvProgressCard: $("recv-progress-card"),
    recvLabel: $("recv-label"),
    recvPercent: $("recv-percent"),
    recvBar: $("recv-bar"),
    recvTrack: $("recv-track"),
    recvBytes: $("recv-bytes"),
    recvSpeed: $("recv-speed"),

    // Gallery
    gallerySection: $("files-gallery-section"),
    galleryEmpty: $("gallery-empty"),
    galleryGrid: $("gallery-grid"),
    galleryCount: $("gallery-count"),

    // Download anchor & lightbox
    downloadAnchor: $("download-anchor"),
    lightbox: $("lightbox"),
    lightboxClose: $("lightbox-close"),
    lightboxBody: $("lightbox-body"),
};

// ──────────────────────────────────────────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────────────────────────────────────────
function formatBytes(b) {
    if (b === 0) return "0 B";
    const k = 1024, s = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(b) / Math.log(k));
    return `${(b / k ** i).toFixed(1)} ${s[i]}`;
}

function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function getInitials(name) {
    const p = name.split("-");
    return (p[0]?.[0] ?? "") + (p[1]?.[0] ?? "");
}

// Sender side log
function log(msg, type = "info") {
    const p = document.createElement("p");
    p.className = `log-entry log-${type}`;
    p.textContent = msg;
    el.statusLog.appendChild(p);
    el.statusLog.scrollTop = el.statusLog.scrollHeight;
}

// Sender progress
function updateSendProgress(label, done, total, speed) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    el.progressSection.hidden = false;
    el.progressLabel.textContent = label;
    el.progressPercent.textContent = `${pct}%`;
    el.progressBar.style.width = `${pct}%`;
    el.progressTrack.setAttribute("aria-valuenow", pct);
    el.progressBytes.textContent = `${formatBytes(done)} / ${formatBytes(total)}`;
    el.progressSpeed.textContent = speed ? `${formatBytes(speed)}/s` : "-- B/s";
}

// Receiver progress
function updateRecvProgress(label, done, total, speed) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    el.recvProgressCard.hidden = false;
    el.recvLabel.textContent = label;
    el.recvPercent.textContent = `${pct}%`;
    el.recvBar.style.width = `${pct}%`;
    el.recvTrack.setAttribute("aria-valuenow", pct);
    el.recvBytes.textContent = `${formatBytes(done)} / ${formatBytes(total)}`;
    el.recvSpeed.textContent = speed ? `${formatBytes(speed)}/s` : "-- B/s";
}

function resetTransferUI() {
    isBusy = false;
    el.btnSend.disabled = !(selectedPeerId && selectedFile);
}

// ──────────────────────────────────────────────────────────────────────────────
// Mode Selection
// ──────────────────────────────────────────────────────────────────────────────
function enterMode(mode) {
    myMode = mode;
    socket.emit("set-mode", mode);

    // Hide mode screen → show app
    el.modeScreen.hidden = true;
    el.appMain.hidden = false;

    if (mode === "sender") {
        el.senderView.hidden = false;
        el.receiverView.hidden = true;
    } else {
        el.senderView.hidden = true;
        el.receiverView.hidden = false;
        // Show own device name in the receiver badge
        el.receiverNameBadge.textContent = myName ?? "Connecting…";
    }
}

function resetToModeScreen() {
    myMode = null;
    selectedPeerId = null;
    selectedPeerName = null;
    selectedFile = null;
    isBusy = false;

    closePeerConnection();
    el.modeScreen.hidden = false;
    el.appMain.hidden = true;
    el.senderView.hidden = true;
    el.receiverView.hidden = true;
}

el.modeSend.addEventListener("click", () => enterMode("sender"));
el.modeReceive.addEventListener("click", () => enterMode("receiver"));
el.btnChangeSend.addEventListener("click", resetToModeScreen);
el.btnChangeRecv.addEventListener("click", resetToModeScreen);

// ──────────────────────────────────────────────────────────────────────────────
// Socket.IO
// ──────────────────────────────────────────────────────────────────────────────
socket = io(); // auto-detect origin — no hardcoded URL

socket.on("connect", () => {
    el.statusDot.className = "status-dot connected";
    el.statusText.textContent = "Connected to signaling server";
    log("Connected to signaling server.", "info");
});

socket.on("disconnect", () => {
    el.statusDot.className = "status-dot disconnected";
    el.statusText.textContent = "Disconnected — reconnecting…";
    log("Lost connection — reconnecting…", "error");
    closePeerConnection();
});

socket.on("self-identity", ({ id, name }) => {
    myId = id;
    myName = name;
    el.selfName.textContent = name;
    // Update receiver badge if already in receiver mode
    if (myMode === "receiver") el.receiverNameBadge.textContent = name;
});

socket.on("mode-confirmed", (mode) => {
    log(`Mode confirmed: ${mode}`, "info");
});

// Server sends filtered peer list (sender sees receivers only)
socket.on("peer-list", (peers) => {
    if (myMode === "sender") renderPeerList(peers);
});

// ── WebRTC Signaling ──────────────────────────────────────────────

/**
 * RECEIVER side: got an offer from a sender.
 * We auto-accept (user already chose Receive mode).
 */
socket.on("offer", async ({ fromId, fromName, offer }) => {
    if (myMode !== "receiver") return;
    if (isBusy) return; // already receiving

    log(`Incoming from "${fromName}" — auto-accepting…`, "info");
    isBusy = true;

    closePeerConnection();
    const iceConfig = await getIceConfig();
    peerConnection = new RTCPeerConnection(iceConfig);
    setupCommonHandlers(peerConnection, fromId);

    // Receiver gets the data channel via ondatachannel event
    peerConnection.ondatachannel = (evt) => {
        dataChannel = evt.channel;
        dataChannel.binaryType = "arraybuffer";
        setupReceiverChannel(dataChannel, fromName);
    };

    try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));

        // Flush buffered ICE candidates now that remote desc is set
        await flushPendingCandidates();

        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit("answer", { targetId: fromId, answer: peerConnection.localDescription });

        log("Answer sent to sender.", "info");
    } catch (err) {
        log(`Offer handling error: ${err.message}`, "error");
        console.error(err);
        isBusy = false;
    }
});

/** SENDER side: got an answer from the receiver. */
socket.on("answer", async ({ answer }) => {
    if (!peerConnection) return;
    try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
        await flushPendingCandidates();
        log("Answer received from receiver.", "info");
    } catch (err) {
        log(`Answer error: ${err.message}`, "error");
        console.error(err);
    }
});

/** Both sides: exchange ICE candidates. */
socket.on("ice-candidate", async ({ candidate }) => {
    if (!candidate) return;
    try {
        if (peerConnection && peerConnection.remoteDescription) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        } else {
            // Buffer until remote description is ready
            pendingCandidates.push(candidate);
        }
    } catch (err) {
        console.warn("ICE candidate add failed (non-fatal):", err.message);
    }
});

async function flushPendingCandidates() {
    for (const c of pendingCandidates) {
        try { await peerConnection.addIceCandidate(new RTCIceCandidate(c)); }
        catch (e) { console.warn("Flushing ICE candidate failed:", e.message); }
    }
    pendingCandidates = [];
}

// ──────────────────────────────────────────────────────────────────────────────
// Peer List (Sender only)
// ──────────────────────────────────────────────────────────────────────────────
function renderPeerList(peers) {
    el.peerList.innerHTML = "";
    el.peerCount.textContent = peers.length;

    if (peers.length === 0) {
        el.peerHint.classList.add("visible");
    } else {
        el.peerHint.classList.remove("visible");
    }

    for (const peer of peers) {
        const li = document.createElement("li");
        li.className = "peer-item";
        li.dataset.id = peer.id;
        if (peer.id === selectedPeerId) li.classList.add("selected");

        li.innerHTML = `
      <div class="peer-avatar">${getInitials(peer.name)}</div>
      <div class="peer-info">
        <div class="peer-name">${peer.name}</div>
        <div class="peer-status-text">● Ready to receive</div>
      </div>
      <div class="peer-select-check"></div>
    `;
        li.addEventListener("click", () => selectPeer(peer.id, peer.name));
        el.peerList.appendChild(li);
    }

    // If selected peer disappeared, clear selection
    if (selectedPeerId && !peers.find((p) => p.id === selectedPeerId)) {
        selectedPeerId = null;
        selectedPeerName = null;
        el.selectedPeerName.textContent = "None — pick a receiver";
        el.btnSend.disabled = true;
        log("Selected receiver disconnected.", "warn");
    }
}

function selectPeer(id, name) {
    selectedPeerId = id;
    selectedPeerName = name;
    document.querySelectorAll(".peer-item").forEach((li) =>
        li.classList.toggle("selected", li.dataset.id === id)
    );
    el.selectedPeerName.textContent = name;
    el.btnSend.disabled = !selectedFile;
    log(`Selected receiver: ${name}`, "info");
}

// ──────────────────────────────────────────────────────────────────────────────
// File input / Drop Zone
// ──────────────────────────────────────────────────────────────────────────────
el.fileInput.addEventListener("change", () => {
    if (el.fileInput.files[0]) handleFileSelected(el.fileInput.files[0]);
});
el.dropZone.addEventListener("click", () => el.fileInput.click());
el.dropZone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") el.fileInput.click(); });
el.dropZone.addEventListener("dragover", (e) => { e.preventDefault(); el.dropZone.classList.add("drag-over"); });
el.dropZone.addEventListener("dragleave", () => el.dropZone.classList.remove("drag-over"));
el.dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    el.dropZone.classList.remove("drag-over");
    if (e.dataTransfer.files[0]) handleFileSelected(e.dataTransfer.files[0]);
});

function handleFileSelected(file) {
    selectedFile = file;
    el.dropZone.classList.add("has-file");
    el.dropFileName.textContent = `${file.name}  (${formatBytes(file.size)})`;
    el.btnSend.disabled = !selectedPeerId;
    log(`File selected: "${file.name}" (${formatBytes(file.size)})`, "info");
}

// ──────────────────────────────────────────────────────────────────────────────
// SENDER flow
// ──────────────────────────────────────────────────────────────────────────────
el.btnSend.addEventListener("click", async () => {
    if (!selectedPeerId || !selectedFile || isBusy) return;
    isBusy = true;
    el.btnSend.disabled = true;
    log(`Connecting to ${selectedPeerName}…`, "info");

    try {
        await initiateConnection(selectedPeerId, selectedFile);
    } catch (err) {
        log(`Connection failed: ${err.message}`, "error");
        console.error(err);
        resetTransferUI();
    }
});

async function initiateConnection(targetId, file) {
    closePeerConnection();

    const iceConfig = await getIceConfig();
    peerConnection = new RTCPeerConnection(iceConfig);
    setupCommonHandlers(peerConnection, targetId);

    // Sender creates the DataChannel
    dataChannel = peerConnection.createDataChannel("athenax-transfer", { ordered: true });
    dataChannel.bufferedAmountLowThreshold = LOW_WATERMARK;
    setupSenderChannel(dataChannel, file);

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    socket.emit("offer", { targetId, offer: peerConnection.localDescription });
    log("Offer sent — waiting for receiver to accept…", "info");
}

// ──────────────────────────────────────────────────────────────────────────────
// Common RTCPeerConnection handlers
// ──────────────────────────────────────────────────────────────────────────────
function setupCommonHandlers(pc, targetId) {
    pc.onicecandidate = ({ candidate }) => {
        if (candidate) socket.emit("ice-candidate", { targetId, candidate });
    };

    pc.oniceconnectionstatechange = () => {
        const s = pc.iceConnectionState;
        log(`ICE state: ${s}`, "info");
        if (s === "failed" || s === "closed") {
            log("Connection lost.", "error");
            closePeerConnection();
            if (myMode === "sender") resetTransferUI();
            else isBusy = false;
        }
    };

    pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") log("WebRTC connection established! 🎉", "info");
        if (pc.connectionState === "failed") { log("Connection failed.", "error"); closePeerConnection(); resetTransferUI(); }
    };
}

// ──────────────────────────────────────────────────────────────────────────────
// Sender DataChannel
// ──────────────────────────────────────────────────────────────────────────────
function setupSenderChannel(channel, file) {
    channel.onopen = () => { log(`Channel open — sending "${file.name}"`, "info"); startSendingFile(channel, file); };
    channel.onerror = (e) => { log(`Channel error: ${e.message ?? "unknown"}`, "error"); resetTransferUI(); };
    channel.onclose = () => log("Sender channel closed.", "info");
}

/**
 * Chunked file sender with backpressure.
 * 1) JSON metadata frame
 * 2) 16KB ArrayBuffer chunks — pauses if bufferedAmount > 1MB
 * 3) JSON {type:"done"} frame
 */
async function startSendingFile(channel, file) {
    sendStartTime = Date.now();
    bytesSent = 0;

    // 1. Metadata
    channel.send(JSON.stringify({
        type: "metadata",
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type || "application/octet-stream",
    }));
    log(`Metadata sent (${formatBytes(file.size)})`, "info");
    updateSendProgress("Preparing…", 0, file.size, 0);

    // 2. Chunk loop
    let offset = 0;

    function readChunk(start) {
        return new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(fr.result);
            fr.onerror = () => reject(fr.error);
            fr.readAsArrayBuffer(file.slice(start, start + CHUNK_SIZE));
        });
    }

    function waitForDrain() {
        return new Promise((resolve) => {
            channel.onbufferedamountlow = () => { channel.onbufferedamountlow = null; resolve(); };
        });
    }

    while (offset < file.size) {
        // Backpressure check
        if (channel.bufferedAmount > HIGH_WATERMARK) {
            log("Buffer full — draining…", "warn");
            await waitForDrain();
        }

        if (channel.readyState !== "open") {
            log("Channel closed during send.", "error");
            resetTransferUI();
            return;
        }

        let chunk;
        try { chunk = await readChunk(offset); }
        catch (e) { log(`Read error: ${e.message}`, "error"); resetTransferUI(); return; }

        channel.send(chunk);
        offset += chunk.byteLength;
        bytesSent += chunk.byteLength;

        const elapsed = (Date.now() - sendStartTime) / 1000;
        const speed = elapsed > 0 ? bytesSent / elapsed : 0;
        updateSendProgress(`Sending "${file.name}"…`, bytesSent, file.size, speed);
    }

    // 3. Done signal
    channel.send(JSON.stringify({ type: "done" }));

    const sec = ((Date.now() - sendStartTime) / 1000).toFixed(1);
    log(`✅ "${file.name}" sent in ${sec}s`, "success");
    updateSendProgress("Transfer complete! ✅", file.size, file.size, 0);
    resetTransferUI();
}

// ──────────────────────────────────────────────────────────────────────────────
// Receiver DataChannel
// ──────────────────────────────────────────────────────────────────────────────
function setupReceiverChannel(channel, fromName) {
    channel.binaryType = "arraybuffer";

    channel.onopen = () => {
        log(`Receiving from "${fromName}"…`, "info");
        el.recvProgressCard.hidden = false;
    };

    channel.onmessage = (evt) => handleReceivedMessage(evt.data, fromName);
    channel.onerror = (e) => { log(`Receive error: ${e.message ?? "?"}`, "error"); resetReceive(); isBusy = false; };
    channel.onclose = () => { log("Transfer channel closed.", "info"); isBusy = false; };
}

function handleReceivedMessage(data, fromName) {
    // JSON frames
    if (typeof data === "string") {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }

        if (msg.type === "metadata") {
            rx.active = true;
            rx.meta = { fileName: msg.fileName, fileSize: msg.fileSize, fileType: msg.fileType };
            rx.chunks = [];
            rx.received = 0;
            rx.startTime = Date.now();
            log(`Incoming: "${msg.fileName}" (${formatBytes(msg.fileSize)}) from "${fromName}"`, "info");
            updateRecvProgress(`Receiving "${msg.fileName}"…`, 0, msg.fileSize, 0);
            return;
        }

        if (msg.type === "done") {
            assembleAndDownload();
            return;
        }
        return;
    }

    // Binary chunk
    if (!rx.active || !rx.meta) return;

    rx.chunks.push(data);
    rx.received += data.byteLength;

    const elapsed = (Date.now() - rx.startTime) / 1000;
    const speed = elapsed > 0 ? rx.received / elapsed : 0;
    updateRecvProgress(`Receiving "${rx.meta.fileName}"…`, rx.received, rx.meta.fileSize, speed);

    // Safety: check if all bytes received without a "done" frame
    if (rx.received >= rx.meta.fileSize) assembleAndDownload();
}

/**
 * Assemble all received chunks into a Blob, trigger download,
 * and add the file to the gallery.
 */
function assembleAndDownload() {
    if (!rx.meta || rx.chunks.length === 0) return;

    const { fileName, fileType, fileSize } = rx.meta;
    log(`Assembling "${fileName}"…`, "info");

    const blob = new Blob(rx.chunks, { type: fileType });
    const url = URL.createObjectURL(blob);

    // Trigger browser download
    el.downloadAnchor.href = url;
    el.downloadAnchor.download = fileName;
    el.downloadAnchor.click();

    const sec = ((Date.now() - rx.startTime) / 1000).toFixed(1);
    log(`✅ "${fileName}" received in ${sec}s — adding to gallery.`, "success");
    updateRecvProgress("Download complete! ✅", fileSize, fileSize, 0);

    // Add to gallery
    addToGallery({ name: fileName, size: fileSize, type: fileType, url, timestamp: Date.now() });

    // Auto-revoke after 5 minutes to free memory
    setTimeout(() => URL.revokeObjectURL(url), 300_000);

    resetReceive();
    isBusy = false;
}

function resetReceive() {
    rx.active = false;
    rx.meta = null;
    rx.chunks = [];
    rx.received = 0;
}

// ──────────────────────────────────────────────────────────────────────────────
// File Gallery
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Returns a descriptive icon emoji for a MIME type.
 */
function fileIcon(type) {
    if (type.startsWith("image/")) return "🖼️";
    if (type.startsWith("video/")) return "🎬";
    if (type.startsWith("audio/")) return "🎵";
    if (type === "application/pdf") return "📄";
    if (type.startsWith("text/")) return "📝";
    if (type.includes("zip") || type.includes("compressed")) return "🗜️";
    return "📦";
}

/**
 * Builds the preview element shown inside the file card thumbnail.
 * Images and videos get media previews; everything else gets an icon.
 */
function buildPreviewElement(file) {
    if (file.type.startsWith("image/")) {
        const img = document.createElement("img");
        img.src = file.url;
        img.alt = file.name;
        img.loading = "lazy";
        return img;
    }
    if (file.type.startsWith("video/")) {
        const vid = document.createElement("video");
        vid.src = file.url;
        vid.muted = true;
        vid.preload = "metadata";
        return vid;
    }
    if (file.type.startsWith("audio/")) {
        const aud = document.createElement("audio");
        aud.src = file.url;
        aud.controls = true;
        return aud;
    }
    const span = document.createElement("span");
    span.className = "file-type-icon";
    span.textContent = fileIcon(file.type);
    return span;
}

/**
 * Opens the lightbox with full-size preview appropriate to file type.
 */
function openLightbox(file) {
    el.lightboxBody.innerHTML = "";
    let content;

    if (file.type.startsWith("image/")) {
        content = document.createElement("img");
        content.src = file.url;
        content.alt = file.name;
    } else if (file.type.startsWith("video/")) {
        content = document.createElement("video");
        content.src = file.url;
        content.controls = true;
        content.autoplay = true;
    } else if (file.type === "application/pdf") {
        content = document.createElement("iframe");
        content.src = file.url;
        content.title = file.name;
    } else if (file.type.startsWith("text/")) {
        // Fetch the Object URL text and show it
        content = document.createElement("div");
        content.className = "lightbox-text";
        content.textContent = "Loading…";
        fetch(file.url).then((r) => r.text()).then((t) => { content.textContent = t; }).catch(() => { content.textContent = "(Could not load text content)"; });
    } else {
        // Non-previewable — just offer download info
        content = document.createElement("div");
        content.className = "lightbox-text";
        content.textContent = `Cannot preview "${file.name}"\nType: ${file.type}\nSize: ${formatBytes(file.size)}\n\nUse the download button on the card.`;
    }

    el.lightboxBody.appendChild(content);
    el.lightbox.hidden = false;
}

el.lightboxClose.addEventListener("click", () => {
    el.lightbox.hidden = true;
    el.lightboxBody.innerHTML = ""; // stop video playback etc.
});
el.lightbox.addEventListener("click", (e) => {
    if (e.target === el.lightbox) {
        el.lightbox.hidden = true;
        el.lightboxBody.innerHTML = "";
    }
});

/**
 * Adds a received file entry to the in-memory array and renders a gallery card.
 */
function addToGallery(file) {
    receivedFiles.unshift(file); // newest first
    el.galleryEmpty.style.display = "none";
    el.galleryCount.textContent = `${receivedFiles.length} file${receivedFiles.length !== 1 ? "s" : ""}`;

    const card = document.createElement("div");
    card.className = "file-card";

    // Preview area
    const preview = document.createElement("div");
    preview.className = "file-card-preview";
    const previewEl = buildPreviewElement(file);
    const overlay = document.createElement("div");
    overlay.className = "preview-overlay";
    overlay.textContent = "🔍 Preview";
    preview.appendChild(previewEl);

    // Only show preview overlay + lightbox for previewable types
    const previewable = file.type.startsWith("image/") || file.type.startsWith("video/") || file.type === "application/pdf" || file.type.startsWith("text/");
    if (previewable) {
        preview.appendChild(overlay);
        preview.addEventListener("click", () => openLightbox(file));
        preview.style.cursor = "pointer";
    }

    // Info
    const info = document.createElement("div");
    info.className = "file-card-info";
    info.innerHTML = `
    <div class="file-card-name" title="${file.name}">${file.name}</div>
    <div class="file-card-meta">
      <span>${formatBytes(file.size)}</span>
      <span>${formatTime(file.timestamp)}</span>
    </div>
  `;

    // Actions
    const actions = document.createElement("div");
    actions.className = "file-card-actions";

    const dlBtn = document.createElement("button");
    dlBtn.className = "btn-card btn-download";
    dlBtn.innerHTML = "⬇ Download";
    dlBtn.addEventListener("click", () => {
        const a = document.createElement("a");
        a.href = file.url;
        a.download = file.name;
        a.click();
    });
    actions.appendChild(dlBtn);

    if (previewable) {
        const prevBtn = document.createElement("button");
        prevBtn.className = "btn-card";
        prevBtn.innerHTML = "🔍 View";
        prevBtn.addEventListener("click", () => openLightbox(file));
        actions.appendChild(prevBtn);
    }

    card.appendChild(preview);
    card.appendChild(info);
    card.appendChild(actions);

    // Insert at top of grid (newest first)
    el.galleryGrid.insertBefore(card, el.galleryGrid.firstChild);
}

// ──────────────────────────────────────────────────────────────────────────────
// Cleanup
// ──────────────────────────────────────────────────────────────────────────────
function closePeerConnection() {
    try { dataChannel?.close(); } catch { }
    try { peerConnection?.close(); } catch { }
    dataChannel = null;
    peerConnection = null;
    pendingCandidates = [];
}
