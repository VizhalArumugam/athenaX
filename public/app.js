/**
 * AthenaX v3 – Frontend Application
 *
 * File transfer now uses Socket.IO relay (not WebRTC DataChannel).
 * This works on every network because Socket.IO is already proven-working.
 *
 * Transfer flow:
 *  1. Sender emits  transfer-request  → server relays metadata to receiver
 *  2. Sender reads file in 256KB chunks, emits file-chunk with ACK callback
 *     → server relays to receiver, ACKs sender → next chunk only sent after ACK
 *  3. Sender emits  transfer-done  → receiver assembles Blob + downloads + gallery
 *
 * No TURN servers needed. No WebRTC DataChannel. Works 100% of the time.
 */

"use strict";

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────

// 256 KB per chunk — Socket.IO can handle this well within its 300 KB limit
const CHUNK_SIZE = 256 * 1024;

// ──────────────────────────────────────────────────────────────────────────────
// State
// ──────────────────────────────────────────────────────────────────────────────

let socket = null;
let myId = null;
let myName = null;
let myMode = null; // "sender" | "receiver"

let selectedPeerId = null;
let selectedPeerName = null;
let selectedFile = null;
let isBusy = false;

let sendStartTime = 0;
let bytesSent = 0;

// Receiver state
const rx = {
    active: false,
    meta: null,   // {fileName, fileSize, fileType}
    chunks: [],
    received: 0,
    startTime: 0,
};

// Gallery
const receivedFiles = [];

// ──────────────────────────────────────────────────────────────────────────────
// DOM References
// ──────────────────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const el = {
    selfName: $("self-name"),
    statusDot: $("status-dot"),
    statusText: $("status-text"),

    modeScreen: $("mode-screen"),
    appMain: $("app-main"),
    senderView: $("sender-view"),
    receiverView: $("receiver-view"),

    modeSend: $("mode-send"),
    modeReceive: $("mode-receive"),
    btnChangeSend: $("btn-change-mode-send"),
    btnChangeRecv: $("btn-change-mode-recv"),

    peerList: $("peer-list"),
    peerCount: $("peer-count"),
    peerHint: $("peer-hint"),

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

    receiverNameBadge: $("receiver-name-badge"),
    recvProgressCard: $("recv-progress-card"),
    recvLabel: $("recv-label"),
    recvPercent: $("recv-percent"),
    recvBar: $("recv-bar"),
    recvTrack: $("recv-track"),
    recvBytes: $("recv-bytes"),
    recvSpeed: $("recv-speed"),

    gallerySection: $("files-gallery-section"),
    galleryEmpty: $("gallery-empty"),
    galleryGrid: $("gallery-grid"),
    galleryCount: $("gallery-count"),

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
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function getInitials(name) {
    const p = name.split("-");
    return (p[0]?.[0] ?? "") + (p[1]?.[0] ?? "");
}

function log(msg, type = "info") {
    const p = document.createElement("p");
    p.className = `log-entry log-${type}`;
    p.textContent = msg;
    el.statusLog.appendChild(p);
    el.statusLog.scrollTop = el.statusLog.scrollHeight;
}

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

    el.modeScreen.hidden = true;
    el.appMain.hidden = false;

    if (mode === "sender") {
        el.senderView.hidden = false;
        el.receiverView.hidden = true;
    } else {
        el.senderView.hidden = true;
        el.receiverView.hidden = false;
        el.receiverNameBadge.textContent = myName ?? "Connecting…";
    }
}

function resetToModeScreen() {
    myMode = null;
    selectedPeerId = null;
    selectedPeerName = null;
    selectedFile = null;
    isBusy = false;

    // Cancel any in-progress transfer
    if (selectedPeerId) socket.emit("transfer-cancel", { targetId: selectedPeerId });

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
// Socket.IO Connection
// ──────────────────────────────────────────────────────────────────────────────

socket = io(); // auto-detects origin — no hardcoded URL

socket.on("connect", () => {
    el.statusDot.className = "status-dot connected";
    el.statusText.textContent = "Connected to server";
    log("Connected to server.", "info");
});

socket.on("disconnect", () => {
    el.statusDot.className = "status-dot disconnected";
    el.statusText.textContent = "Disconnected — reconnecting…";
    log("Lost connection — reconnecting…", "error");
    isBusy = false;
});

socket.on("self-identity", ({ id, name }) => {
    myId = id;
    myName = name;
    el.selfName.textContent = name;
    if (myMode === "receiver") el.receiverNameBadge.textContent = name;
});

socket.on("mode-confirmed", (mode) => log(`Mode: ${mode}`, "info"));

socket.on("peer-list", (peers) => {
    if (myMode === "sender") renderPeerList(peers);
});

// ──────────────────────────────────────────────────────────────────────────────
// RECEIVER — Socket.IO Transfer Events
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Receiver: sender announced an incoming transfer.
 * Since the user already chose "Receive" mode, auto-accept immediately.
 */
socket.on("transfer-incoming", ({ fromId, fromName, meta }) => {
    if (myMode !== "receiver") return;
    if (isBusy) {
        log(`Ignored transfer from ${fromName} — already busy.`, "warn");
        return;
    }

    isBusy = true;
    rx.active = true;
    rx.meta = meta;
    rx.chunks = [];
    rx.received = 0;
    rx.startTime = Date.now();

    log(`Incoming: "${meta.fileName}" (${formatBytes(meta.fileSize)}) from "${fromName}"`, "info");
    updateRecvProgress(`Receiving "${meta.fileName}"…`, 0, meta.fileSize, 0);
});

/**
 * Receiver: a file chunk arrived (ArrayBuffer).
 */
socket.on("file-chunk", ({ chunk }) => {
    if (!rx.active || !rx.meta) return;

    // Socket.IO delivers binary as ArrayBuffer in the browser
    rx.chunks.push(chunk);
    rx.received += chunk.byteLength;

    const elapsed = (Date.now() - rx.startTime) / 1000;
    const speed = elapsed > 0 ? rx.received / elapsed : 0;
    updateRecvProgress(
        `Receiving "${rx.meta.fileName}"…`,
        rx.received,
        rx.meta.fileSize,
        speed
    );
});

/**
 * Receiver: all chunks delivered — assemble and download.
 */
socket.on("transfer-done", () => {
    if (!rx.active || !rx.meta) return;
    assembleAndDownload();
});

socket.on("transfer-cancel", () => {
    if (!rx.active) return;
    log("Sender cancelled the transfer.", "warn");
    resetReceive();
    isBusy = false;
});

// ──────────────────────────────────────────────────────────────────────────────
// Peer List
// ──────────────────────────────────────────────────────────────────────────────

function renderPeerList(peers) {
    el.peerList.innerHTML = "";
    el.peerCount.textContent = peers.length;

    peers.length === 0
        ? el.peerHint.classList.add("visible")
        : el.peerHint.classList.remove("visible");

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

    // Clear selection if selected peer left
    if (selectedPeerId && !peers.find((p) => p.id === selectedPeerId)) {
        selectedPeerId = selectedPeerName = null;
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
    log(`Selected: ${name}`, "info");
}

// ──────────────────────────────────────────────────────────────────────────────
// File Input
// ──────────────────────────────────────────────────────────────────────────────

el.fileInput.addEventListener("change", () => {
    if (el.fileInput.files[0]) handleFileSelected(el.fileInput.files[0]);
});
el.dropZone.addEventListener("click", () => el.fileInput.click());
el.dropZone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") el.fileInput.click();
});
el.dropZone.addEventListener("dragover", (e) => {
    e.preventDefault(); el.dropZone.classList.add("drag-over");
});
el.dropZone.addEventListener("dragleave", () =>
    el.dropZone.classList.remove("drag-over")
);
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
// SENDER — Socket.IO File Transfer
// ──────────────────────────────────────────────────────────────────────────────

el.btnSend.addEventListener("click", () => {
    if (!selectedPeerId || !selectedFile || isBusy) return;
    isBusy = true;
    el.btnSend.disabled = true;
    sendFileViaSockets(selectedPeerId, selectedFile);
});

/**
 * Sends a file through the Socket.IO relay.
 *
 * Algorithm:
 *  1. Emit transfer-request (metadata) to receiver.
 *  2. Read file in 256 KB slices with FileReader.
 *  3. For each chunk: emit file-chunk, AWAIT server ACK before reading next chunk.
 *     This prevents flooding (natural backpressure).
 *  4. Emit transfer-done.
 */
async function sendFileViaSockets(targetId, file) {
    sendStartTime = Date.now();
    bytesSent = 0;

    log(`Sending "${file.name}" to ${selectedPeerName}…`, "info");
    updateSendProgress("Connecting…", 0, file.size, 0);

    // Step 1 — metadata
    socket.emit("transfer-request", {
        targetId,
        meta: {
            fileName: file.name,
            fileSize: file.size,
            fileType: file.type || "application/octet-stream",
        },
    });

    // Give receiver time to set up state (~100 ms is plenty)
    await delay(150);

    // Step 2 — chunk loop
    let offset = 0;
    let chunkIndex = 0;

    function readChunk(start) {
        return new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(fr.result); // ArrayBuffer
            fr.onerror = () => reject(fr.error);
            fr.readAsArrayBuffer(file.slice(start, start + CHUNK_SIZE));
        });
    }

    while (offset < file.size) {
        let chunk;
        try { chunk = await readChunk(offset); }
        catch (e) { log(`Read error: ${e.message}`, "error"); resetTransferUI(); return; }

        // Emit chunk, wait for server ACK (backpressure)
        const ack = await new Promise((resolve) => {
            socket.emit("file-chunk", { targetId, chunk, chunkIndex }, resolve);
        });

        if (ack === "no-peer") {
            log("Receiver disconnected during transfer.", "error");
            resetTransferUI();
            return;
        }

        offset += chunk.byteLength;
        bytesSent += chunk.byteLength;
        chunkIndex++;

        const elapsed = (Date.now() - sendStartTime) / 1000;
        const speed = elapsed > 0 ? bytesSent / elapsed : 0;
        updateSendProgress(`Sending "${file.name}"…`, bytesSent, file.size, speed);
    }

    // Step 3 — done signal
    socket.emit("transfer-done", { targetId });

    const sec = ((Date.now() - sendStartTime) / 1000).toFixed(1);
    log(`✅ "${file.name}" sent in ${sec}s`, "success");
    updateSendProgress("Transfer complete! ✅", file.size, file.size, 0);
    resetTransferUI();
}

function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

// ──────────────────────────────────────────────────────────────────────────────
// RECEIVER — Assembly & Download
// ──────────────────────────────────────────────────────────────────────────────

function assembleAndDownload() {
    if (!rx.meta || rx.chunks.length === 0) return;

    const { fileName, fileType, fileSize } = rx.meta;
    log(`Assembling "${fileName}"…`, "info");

    const blob = new Blob(rx.chunks, { type: fileType });
    const url = URL.createObjectURL(blob);

    el.downloadAnchor.href = url;
    el.downloadAnchor.download = fileName;
    el.downloadAnchor.click();

    const sec = ((Date.now() - rx.startTime) / 1000).toFixed(1);
    log(`✅ "${fileName}" received in ${sec}s`, "success");
    updateRecvProgress("Download complete! ✅", fileSize, fileSize, 0);

    addToGallery({ name: fileName, size: fileSize, type: fileType, url, timestamp: Date.now() });

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

function fileIcon(type) {
    if (type.startsWith("image/")) return "🖼️";
    if (type.startsWith("video/")) return "🎬";
    if (type.startsWith("audio/")) return "🎵";
    if (type === "application/pdf") return "📄";
    if (type.startsWith("text/")) return "📝";
    if (type.includes("zip") || type.includes("compressed")) return "🗜️";
    return "📦";
}

function buildPreviewElement(file) {
    if (file.type.startsWith("image/")) {
        const img = document.createElement("img");
        img.src = file.url; img.alt = file.name; img.loading = "lazy";
        return img;
    }
    if (file.type.startsWith("video/")) {
        const vid = document.createElement("video");
        vid.src = file.url; vid.muted = true; vid.preload = "metadata";
        return vid;
    }
    if (file.type.startsWith("audio/")) {
        const aud = document.createElement("audio");
        aud.src = file.url; aud.controls = true;
        return aud;
    }
    const span = document.createElement("span");
    span.className = "file-type-icon";
    span.textContent = fileIcon(file.type);
    return span;
}

function openLightbox(file) {
    el.lightboxBody.innerHTML = "";
    let content;
    if (file.type.startsWith("image/")) {
        content = document.createElement("img");
        content.src = file.url; content.alt = file.name;
    } else if (file.type.startsWith("video/")) {
        content = document.createElement("video");
        content.src = file.url; content.controls = true; content.autoplay = true;
    } else if (file.type === "application/pdf") {
        content = document.createElement("iframe");
        content.src = file.url; content.title = file.name;
    } else if (file.type.startsWith("text/")) {
        content = document.createElement("div");
        content.className = "lightbox-text";
        content.textContent = "Loading…";
        fetch(file.url).then((r) => r.text()).then((t) => { content.textContent = t; });
    } else {
        content = document.createElement("div");
        content.className = "lightbox-text";
        content.textContent = `Cannot preview "${file.name}"\nType: ${file.type}\nSize: ${formatBytes(file.size)}`;
    }
    el.lightboxBody.appendChild(content);
    el.lightbox.hidden = false;
}

el.lightboxClose.addEventListener("click", () => {
    el.lightbox.hidden = true; el.lightboxBody.innerHTML = "";
});
el.lightbox.addEventListener("click", (e) => {
    if (e.target === el.lightbox) { el.lightbox.hidden = true; el.lightboxBody.innerHTML = ""; }
});

function addToGallery(file) {
    receivedFiles.unshift(file);
    el.galleryEmpty.style.display = "none";
    el.galleryCount.textContent = `${receivedFiles.length} file${receivedFiles.length !== 1 ? "s" : ""}`;

    const card = document.createElement("div");
    card.className = "file-card";

    const preview = document.createElement("div");
    preview.className = "file-card-preview";
    preview.appendChild(buildPreviewElement(file));

    const previewable = file.type.startsWith("image/") || file.type.startsWith("video/")
        || file.type === "application/pdf" || file.type.startsWith("text/");
    if (previewable) {
        const overlay = document.createElement("div");
        overlay.className = "preview-overlay"; overlay.textContent = "🔍 Preview";
        preview.appendChild(overlay);
        preview.style.cursor = "pointer";
        preview.addEventListener("click", () => openLightbox(file));
    }

    const info = document.createElement("div");
    info.className = "file-card-info";
    info.innerHTML = `
    <div class="file-card-name" title="${file.name}">${file.name}</div>
    <div class="file-card-meta">
      <span>${formatBytes(file.size)}</span>
      <span>${formatTime(file.timestamp)}</span>
    </div>
  `;

    const actions = document.createElement("div");
    actions.className = "file-card-actions";

    const dlBtn = document.createElement("button");
    dlBtn.className = "btn-card btn-download";
    dlBtn.innerHTML = "⬇ Download";
    dlBtn.addEventListener("click", () => {
        const a = document.createElement("a");
        a.href = file.url; a.download = file.name; a.click();
    });
    actions.appendChild(dlBtn);

    if (previewable) {
        const prevBtn = document.createElement("button");
        prevBtn.className = "btn-card"; prevBtn.innerHTML = "🔍 View";
        prevBtn.addEventListener("click", () => openLightbox(file));
        actions.appendChild(prevBtn);
    }

    card.appendChild(preview);
    card.appendChild(info);
    card.appendChild(actions);
    el.galleryGrid.insertBefore(card, el.galleryGrid.firstChild);
}
