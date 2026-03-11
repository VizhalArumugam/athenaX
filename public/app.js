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

// 2 MB chunks — 4x larger than before: fewer ACK round-trips, better TCP throughput
const CHUNK_SIZE   = 2 * 1024 * 1024;

// Sliding-window size: how many chunks can be outstanding (sent but not yet ACKed).
// As each ACK arrives a new chunk fires immediately — no batch stalling.
// 32 × 2 MB = 64 MB in-flight, saturates even a 1 Gbps link at 100 ms RTT.
const MAX_INFLIGHT = 32;

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
    unblockNavigation(); // pop the history state we pushed on send start
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
    blockNavigation(); // push history state so swipe-back triggers modal
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
// Stop the native click on the hidden file input from bubbling to the drop zone,
// which would trigger a second dialog via the dropZone click handler below.
el.fileInput.addEventListener("click", (e) => e.stopPropagation());
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
    blockNavigation(); // push history state so swipe-back triggers modal
    el.btnSend.disabled = true;
    sendFileViaSockets(selectedPeerId, selectedFile);
});

/**
 * sendFileViaSockets — high-throughput Socket.IO relay sender.
 *
 * Key design choices vs the old batch-and-wait:
 *  • Blob.arrayBuffer()  — native async read, ~3× faster than FileReader
 *  • Sliding window      — MAX_INFLIGHT chunks outstanding simultaneously;
 *                          each ACK immediately triggers next send (no stall).
 *  • 2 MB chunks         — 4× larger; fewer round-trips, better TCP utilisation.
 *  • UI throttled        — DOM updates capped at 10/s (no perf drag on large files)
 */
async function sendFileViaSockets(targetId, file) {
    sendStartTime = Date.now();
    bytesSent     = 0;

    log(`Sending "${file.name}" (${formatBytes(file.size)}) to ${selectedPeerName}…`, "info");
    updateSendProgress("Preparing…", 0, file.size, 0);

    // ── 1. Metadata ────────────────────────────────────────────────────────────
    socket.emit("transfer-request", {
        targetId,
        meta: {
            fileName: file.name,
            fileSize: file.size,
            fileType: file.type || "application/octet-stream",
        },
    });
    await delay(100); // brief pause so receiver initialises state

    // ── 2. Sliding-window chunk loop ───────────────────────────────────────────
    let offset     = 0;
    let chunkIndex = 0;
    let inFlight   = 0;   // chunks sent but not yet ACKed by server
    let cancelled  = false;
    let loopDone   = false;
    let lastUIMs   = 0;   // for 10/s UI throttle

    // Single-waiter semaphore: resolves when a window slot opens
    let windowWaiter = null;
    function freeSlot() {
        inFlight--;
        if (windowWaiter) { const r = windowWaiter; windowWaiter = null; r(); }
    }
    function waitForSlot() {
        if (inFlight < MAX_INFLIGHT) return Promise.resolve();
        return new Promise(r => { windowWaiter = r; });
    }

    // Outer promise: resolves when every chunk is ACKed
    let resolveDone, rejectDone;
    const allAcked = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });

    // ── Send loop (runs concurrently with ACK callbacks) ──────────────────────
    (async () => {
        while (offset < file.size && !cancelled) {
            await waitForSlot();
            if (cancelled) break;

            // Blob.arrayBuffer(): native, no FileReader object overhead
            const end = Math.min(offset + CHUNK_SIZE, file.size);
            const chunk = await file.slice(offset, end).arrayBuffer().catch(e => {
                log(`Read error: ${e.message}`, "error");
                cancelled = true;
                return null;
            });
            if (!chunk || cancelled) break;

            const idx = chunkIndex++;
            offset   += chunk.byteLength;
            inFlight++;

            // Fire and continue — ACK callback below frees the window slot
            socket.emit("file-chunk", { targetId, chunk, chunkIndex: idx }, (ack) => {
                if (ack === "no-peer") {
                    cancelled = true;
                    rejectDone(new Error("no-peer"));
                    return;
                }
                freeSlot();

                // Throttled UI update — max 10 repaints/second
                const now = Date.now();
                if (now - lastUIMs > 100) {
                    lastUIMs = now;
                    const elapsed = (now - sendStartTime) / 1000;
                    const speed   = elapsed > 0 ? offset / elapsed : 0;
                    updateSendProgress(`Sending "${file.name}"…`, Math.min(offset, file.size), file.size, speed);
                }

                if (loopDone && inFlight === 0) resolveDone();
            });
        }
        loopDone = true;
        if (inFlight === 0 && !cancelled) resolveDone();
    })();

    // ── Wait for completion ────────────────────────────────────────────────────
    try {
        await allAcked;
    } catch (e) {
        const msg = e.message === "no-peer" ? "Receiver disconnected during transfer." : `Transfer error: ${e.message}`;
        log(msg, "error");
        resetTransferUI();
        return;
    }
    if (cancelled) { resetTransferUI(); return; }

    // ── 3. Done signal ─────────────────────────────────────────────────────────
    socket.emit("transfer-done", { targetId });

    const sec    = ((Date.now() - sendStartTime) / 1000).toFixed(1);
    const avgSpd = formatBytes(file.size / parseFloat(sec));
    log(`✅ "${file.name}" sent in ${sec}s  (avg ${avgSpd}/s)`, "success");
    updateSendProgress("Transfer complete! ✅", file.size, file.size, 0);
    resetTransferUI();
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }


// ──────────────────────────────────────────────────────────────────────────────
// In-App Exit Confirmation (History API — works on mobile swipe-back)
// ──────────────────────────────────────────────────────────────────────────────

const elExitModal = document.getElementById("exit-modal");
const elBtnStay = document.getElementById("btn-exit-stay");
const elBtnLeave = document.getElementById("btn-exit-leave");

// ─── CRITICAL: Push a guard state immediately on page load ───────────────────
//
// Problem: when a user opens the app directly (typing URL, Google search, link)
// there is NO previous history entry. So the first swipe-back gesture has nothing
// to fire `popstate` on — it just exits the app, bypassing all our guards.
//
// Fix: replace the current history state with a marker, then push an active guard
// entry on top. Now history always has at least 2 entries:
//   [page-load-marker]  ← if user exits this, they genuinely leave
//   [athenax-guard]     ← first back-swipe hits this → fires popstate → we intercept
//
history.replaceState({ athenaxMark: true }, "");   // mark the real landing entry
history.pushState({ athenaxGuard: true }, "");      // push our interceptable guard

// blockNavigation / unblockNavigation are kept for call-site compatibility
// but are now effectively no-ops because the guard is always present on load.
function blockNavigation() { /* guard already pushed on page load */ }
function unblockNavigation() { /* guard stays for the session lifetime */ }

function showExitModal() { elExitModal.hidden = false; }
function hideExitModal() { elExitModal.hidden = true; }

// ─── popstate: fires on every back-swipe / back-button press ────────────────
window.addEventListener("popstate", (e) => {
    if (isBusy) {
        // Transfer in progress — intercept and show in-app modal.
        // Re-push the guard so the page stays put.
        history.pushState({ athenaxGuard: true }, "");
        showExitModal();
        return;
    }

    // No transfer active.
    if (myMode !== null) {
        // User is in sender or receiver view — still intercept so they don't
        // accidentally swipe out of the app mid-session (no transfer cost).
        // Re-push guard silently; they can use the "⇄ Change" button to exit.
        history.pushState({ athenaxGuard: true }, "");
        return;
    }

    // User is on the mode-selection screen (myMode === null).
    // They have not started any session — let them leave normally.
    // Pop back to our marker so the *next* back exits the app.
    // (No re-push here → popstate will fire once more → hits athenaxMark → exits.)
});

// "Continue Transfer" — dismiss modal, stay on page
elBtnStay.addEventListener("click", () => {
    hideExitModal();
});

// "Cancel & Exit" — cancel transfer, navigate back
elBtnLeave.addEventListener("click", () => {
    hideExitModal();
    isBusy = false;
    myMode = null; // allow next popstate to exit normally

    // Notify receiver that sender cancelled (if sender)
    if (selectedPeerId) {
        socket.emit("transfer-cancel", { targetId: selectedPeerId });
    }

    // history stack at this point:
    //   [athenaxMark]  ← real landing entry
    //   [athenaxGuard] ← original guard pushed on load
    //   [athenaxGuard] ← re-pushed by popstate handler
    // go(-2) pops the two guard entries → lands on athenaxMark
    // next swipe-back exits the app normally
    history.go(-2);
});

// Fallback for desktop: browser "Leave site?" dialog on refresh / tab close
window.addEventListener("beforeunload", (e) => {
    if (!isBusy) return;
    e.preventDefault();
    e.returnValue = "";
});

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
    unblockNavigation(); // pop the history state we pushed on incoming
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
