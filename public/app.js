/**
 * AthenaX – Frontend Application
 *
 * Handles:
 *  1. Socket.IO connection & signaling relay
 *  2. WebRTC peer connection lifecycle
 *  3. File selection, chunked reading (16 KB), backpressure
 *  4. Receiver side: buffering chunks, assembling Blob, triggering download
 *  5. UI: peer list, progress bar, status log, incoming-file modal
 *
 * ═══════════ IMPORTANT DESIGN DECISIONS ═══════════
 *
 *  • CHUNK_SIZE = 16 384 bytes  — balances throughput vs memory
 *  • HIGH_WATERMARK = 1 MB  — pause sending if bufferedAmount > this
 *  • LOW_WATERMARK = 256 KB  — resume when bufferedamountlow event fires
 *    (DataChannel.bufferedAmountLowThreshold is set to LOW_WATERMARK)
 *  • Files are read sequentially via FileReader.readAsArrayBuffer,
 *    one chunk at a time — we never load the whole file into RAM.
 *  • The first message over the channel is a JSON metadata frame so
 *    the receiver knows the filename, size, and MIME type.
 */

"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const CHUNK_SIZE = 16 * 1024;        // 16 KB per chunk
const HIGH_WATERMARK = 1 * 1024 * 1024;  // 1 MB — pause threshold
const LOW_WATERMARK = 256 * 1024;       // 256 KB — resume threshold

/** Public STUN servers (Google + open-relay for broader compatibility) */
const ICE_SERVERS = {
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun2.l.google.com:19302" },
        { urls: "stun:stun.stunprotocol.org:3478" },
    ],
};

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

let socket = null;          // Socket.IO socket
let myId = null;          // Own socket id assigned by server
let myName = null;          // Own human-readable name

let selectedPeerId = null;  // Currently selected peer id
let selectedPeerName = null;  // Currently selected peer name

let peerConnection = null;  // RTCPeerConnection (active connection)
let dataChannel = null;  // RTCDataChannel (active channel)
let pendingCandidates = [];   // ICE candidates buffered before remote desc is set

// File being sent
let selectedFile = null;

// Receiver state
const receive = {
    active: false,
    meta: null,   // { fileName, fileSize, fileType }
    chunks: [],
    received: 0,
    startTime: 0,
};

// Speed tracking for sender
let sendStartTime = 0;
let bytesSent = 0;

// Flag to prevent multiple connections at once
let isBusy = false;

// ─────────────────────────────────────────────────────────────────────────────
// DOM References
// ─────────────────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const dom = {
    selfName: $("self-name"),
    peerList: $("peer-list"),
    peerCount: $("peer-count"),
    peerHint: $("peer-hint"),
    statusDot: $("status-dot"),
    statusText: $("status-text"),
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
    incomingModal: $("incoming-modal"),
    modalFrom: $("modal-from"),
    modalFileName: $("modal-file-name"),
    modalFileSize: $("modal-file-size"),
    btnAccept: $("btn-accept"),
    btnDecline: $("btn-decline"),
    downloadAnchor: $("download-anchor"),
};

// ─────────────────────────────────────────────────────────────────────────────
// Utility helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Format bytes into human-readable string. */
function formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

/** Append a line to the on-screen status log. */
function log(message, type = "info") {
    const entry = document.createElement("p");
    entry.className = `log-entry log-${type}`;
    entry.textContent = message;
    dom.statusLog.appendChild(entry);
    dom.statusLog.scrollTop = dom.statusLog.scrollHeight;
}

/** Derive initials from a device name like "Swift-Falcon-4B" → "SF" */
function getInitials(name) {
    const parts = name.split("-");
    return (parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "");
}

/** Update the progress bar and metadata line. */
function updateProgress(label, bytesDone, total, speed) {
    const pct = total > 0 ? Math.round((bytesDone / total) * 100) : 0;
    dom.progressSection.hidden = false;
    dom.progressLabel.textContent = label;
    dom.progressPercent.textContent = `${pct}%`;
    dom.progressBar.style.width = `${pct}%`;
    dom.progressTrack.setAttribute("aria-valuenow", pct);
    dom.progressBytes.textContent = `${formatBytes(bytesDone)} / ${formatBytes(total)}`;
    dom.progressSpeed.textContent = speed ? `${formatBytes(speed)}/s` : "-- B/s";
}

/** Reset the UI after a transfer completes or fails. */
function resetTransferUI(keepProgress = false) {
    isBusy = false;
    if (!keepProgress) {
        dom.progressSection.hidden = true;
        dom.progressBar.style.width = "0%";
    }
    dom.btnSend.disabled = !(selectedPeerId && selectedFile);
}

// ─────────────────────────────────────────────────────────────────────────────
// Socket.IO — Connect and handle signaling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * io() with no arguments auto-detects the origin, so the frontend works
 * whether served from localhost:3000 or a production HTTPS domain.  We never
 * hardcode a URL.
 */
socket = io();

socket.on("connect", () => {
    dom.statusDot.className = "status-dot connected";
    dom.statusText.textContent = "Connected to signaling server";
    log("Connected to signaling server.", "info");
});

socket.on("disconnect", () => {
    dom.statusDot.className = "status-dot disconnected";
    dom.statusText.textContent = "Disconnected — reconnecting…";
    log("Lost connection to signaling server. Reconnecting…", "error");
    closePeerConnection();
});

/** Server tells us our own identity. */
socket.on("self-identity", ({ id, name }) => {
    myId = id;
    myName = name;
    dom.selfName.textContent = name;
});

/** Server broadcasts the full peer list whenever it changes. */
socket.on("peer-list", (peers) => {
    renderPeerList(peers);
});

// ── WebRTC Signaling ────────────────────────────────────────────────────────

/**
 * We received an offer from a remote peer who wants to send us a file.
 * We create an RTCPeerConnection as the "answerer", set the remote description,
 * and reply with our answer.
 */
socket.on("offer", async ({ fromId, fromName, offer }) => {
    if (isBusy) {
        // Politely decline if already in a transfer
        log(`Ignored offer from ${fromName} — already busy.`, "warn");
        return;
    }

    log(`Incoming connection request from "${fromName}"…`, "info");

    // We need to show the metadata modal AFTER the data channel opens, so we
    // set up the peer connection now but show the modal when metadata arrives.
    closePeerConnection(); // clean slate

    peerConnection = new RTCPeerConnection(ICE_SERVERS);
    setupCommonPCHandlers(peerConnection, fromId);

    // Answerer receives the data channel via ondatachannel
    peerConnection.ondatachannel = (event) => {
        dataChannel = event.channel;
        dataChannel.binaryType = "arraybuffer";
        setupReceiverChannel(dataChannel, fromName);
    };

    try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));

        // Flush any ICE candidates buffered before remote desc was ready
        for (const c of pendingCandidates) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(c)).catch(console.warn);
        }
        pendingCandidates = [];

        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        socket.emit("answer", { targetId: fromId, answer: peerConnection.localDescription });
        log("Sent answer to initiator.", "info");
    } catch (err) {
        log(`Error handling offer: ${err.message}`, "error");
        console.error(err);
    }
});

/** Initiator receives the answer and sets it as remote description. */
socket.on("answer", async ({ fromId, answer }) => {
    if (!peerConnection) return;
    try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));

        // Flush buffered ICE candidates
        for (const c of pendingCandidates) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(c)).catch(console.warn);
        }
        pendingCandidates = [];
        log("Remote description (answer) set.", "info");
    } catch (err) {
        log(`Error handling answer: ${err.message}`, "error");
        console.error(err);
    }
});

/** ICE candidate received — add it to the peer connection. */
socket.on("ice-candidate", async ({ fromId, candidate }) => {
    if (!peerConnection) return;
    if (!candidate) return;

    try {
        if (peerConnection.remoteDescription) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        } else {
            // Remote description hasn't been set yet — buffer the candidate
            pendingCandidates.push(candidate);
        }
    } catch (err) {
        // Non-fatal: ICE candidate errors are common during negotiation
        console.warn("ICE candidate error:", err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Peer List Rendering
// ─────────────────────────────────────────────────────────────────────────────

function renderPeerList(peers) {
    dom.peerList.innerHTML = "";

    // Exclude ourselves from the list (can't send files to yourself)
    const others = peers.filter((p) => p.id !== myId);

    // Update count badge
    dom.peerCount.textContent = others.length;

    // Show/hide hint
    if (others.length === 0) {
        dom.peerHint.classList.add("visible");
    } else {
        dom.peerHint.classList.remove("visible");
    }

    for (const peer of others) {
        const li = document.createElement("li");
        li.className = "peer-item";
        li.dataset.peerId = peer.id;
        li.dataset.peerName = peer.name;

        if (peer.id === selectedPeerId) li.classList.add("selected");

        li.innerHTML = `
      <div class="peer-avatar">${getInitials(peer.name)}</div>
      <div class="peer-info">
        <div class="peer-name">${peer.name}</div>
        <div class="peer-status-text">Ready to receive</div>
      </div>
      <div class="peer-select-check"></div>
    `;

        li.addEventListener("click", () => selectPeer(peer.id, peer.name));
        dom.peerList.appendChild(li);
    }

    // If the selected peer disconnected, clear selection
    if (selectedPeerId && !others.find((p) => p.id === selectedPeerId)) {
        clearPeerSelection();
        log("Selected peer disconnected.", "warn");
    }
}

function selectPeer(id, name) {
    selectedPeerId = id;
    selectedPeerName = name;

    // Update list UI
    document.querySelectorAll(".peer-item").forEach((el) => {
        el.classList.toggle("selected", el.dataset.peerId === id);
    });

    dom.selectedPeerName.textContent = name;
    dom.btnSend.disabled = !selectedFile;
    log(`Selected peer: ${name}`, "info");
}

function clearPeerSelection() {
    selectedPeerId = null;
    selectedPeerName = null;
    dom.selectedPeerName.textContent = "None — pick a device on the left";
    dom.btnSend.disabled = true;
    document.querySelectorAll(".peer-item").forEach((el) => el.classList.remove("selected"));
}

// ─────────────────────────────────────────────────────────────────────────────
// File Input / Drop Zone
// ─────────────────────────────────────────────────────────────────────────────

dom.fileInput.addEventListener("change", () => {
    if (dom.fileInput.files[0]) handleFileSelected(dom.fileInput.files[0]);
});

dom.dropZone.addEventListener("click", () => dom.fileInput.click());

dom.dropZone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") dom.fileInput.click();
});

dom.dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dom.dropZone.classList.add("drag-over");
});

dom.dropZone.addEventListener("dragleave", () => {
    dom.dropZone.classList.remove("drag-over");
});

dom.dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dom.dropZone.classList.remove("drag-over");
    const file = e.dataTransfer.files[0];
    if (file) handleFileSelected(file);
});

function handleFileSelected(file) {
    selectedFile = file;
    dom.dropZone.classList.add("has-file");
    dom.dropFileName.textContent = `${file.name} (${formatBytes(file.size)})`;
    dom.btnSend.disabled = !selectedPeerId;
    log(`File selected: "${file.name}" (${formatBytes(file.size)})`, "info");
}

// ─────────────────────────────────────────────────────────────────────────────
// Send File — Initiator side
// ─────────────────────────────────────────────────────────────────────────────

dom.btnSend.addEventListener("click", async () => {
    if (!selectedPeerId || !selectedFile || isBusy) return;
    isBusy = true;
    dom.btnSend.disabled = true;

    log(`Connecting to ${selectedPeerName}…`, "info");

    try {
        await initiateConnection(selectedPeerId, selectedFile);
    } catch (err) {
        log(`Failed to start transfer: ${err.message}`, "error");
        console.error(err);
        resetTransferUI();
    }
});

/**
 * Initiator flow:
 *  1. Create RTCPeerConnection
 *  2. Create DataChannel
 *  3. Create offer → set local description → signal offer
 */
async function initiateConnection(targetId, file) {
    closePeerConnection();

    peerConnection = new RTCPeerConnection(ICE_SERVERS);
    setupCommonPCHandlers(peerConnection, targetId);

    // Create the data channel BEFORE the offer
    dataChannel = peerConnection.createDataChannel("file-transfer", {
        ordered: true, // guarantee ordering (TCP-like)
    });
    // Set buffer thresholds
    dataChannel.bufferedAmountLowThreshold = LOW_WATERMARK;
    setupSenderChannel(dataChannel, file);

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    socket.emit("offer", {
        targetId,
        offer: peerConnection.localDescription,
    });

    log("Offer sent — waiting for answer…", "info");
}

// ─────────────────────────────────────────────────────────────────────────────
// Common RTCPeerConnection Handlers
// ─────────────────────────────────────────────────────────────────────────────

function setupCommonPCHandlers(pc, targetId) {
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit("ice-candidate", {
                targetId,
                candidate: event.candidate,
            });
        }
    };

    pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        log(`ICE connection state: ${state}`, "info");
        if (state === "failed" || state === "disconnected" || state === "closed") {
            log("Peer connection lost.", "error");
            closePeerConnection();
            resetTransferUI();
        }
    };

    pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        if (state === "connected") {
            log("Peer connection established! 🎉", "info");
        } else if (state === "failed") {
            log("WebRTC connection failed. Try again.", "error");
            closePeerConnection();
            resetTransferUI();
        }
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sender DataChannel Setup
// ─────────────────────────────────────────────────────────────────────────────

function setupSenderChannel(channel, file) {
    channel.onopen = () => {
        log(`DataChannel open — sending "${file.name}"…`, "info");
        startSendingFile(channel, file);
    };

    channel.onerror = (e) => {
        log(`DataChannel error: ${e.message || "unknown"}`, "error");
        resetTransferUI();
    };

    channel.onclose = () => {
        log("DataChannel closed (sender side).", "info");
    };
}

/**
 * ─── CHUNKED FILE SENDER WITH BACKPRESSURE ────────────────────────
 *
 * Algorithm:
 *  1. Send a JSON metadata message first.
 *  2. Use FileReader to read one 16 KB slice at a time.
 *  3. Before calling channel.send(), check bufferedAmount.
 *     If > HIGH_WATERMARK, pause; wait for bufferedamountlow, then resume.
 *  4. After each send, advance offset and read the next chunk.
 *  5. When all bytes are sent, send a JSON {type:"done"} frame.
 */
async function startSendingFile(channel, file) {
    sendStartTime = Date.now();
    bytesSent = 0;
    let offset = 0;

    // ── Step 1: send metadata ──────────────────────────────────────────
    const meta = JSON.stringify({
        type: "metadata",
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type || "application/octet-stream",
    });
    channel.send(meta);
    log(`Metadata sent (${formatBytes(file.size)}).`, "info");

    updateProgress("Preparing to send…", 0, file.size, 0);

    // ── Step 2: chunk loop ─────────────────────────────────────────────
    /**
     * Reads a single slice starting at `offset` and resolves with an ArrayBuffer.
     */
    function readChunk(start) {
        return new Promise((resolve, reject) => {
            const slice = file.slice(start, start + CHUNK_SIZE);
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsArrayBuffer(slice);
        });
    }

    /**
     * Returns a Promise that resolves when bufferedAmount drops below LOW_WATERMARK.
     * We use the native `bufferedamountlow` event for efficiency.
     */
    function waitForDrain() {
        return new Promise((resolve) => {
            channel.onbufferedamountlow = () => {
                channel.onbufferedamountlow = null;
                resolve();
            };
        });
    }

    while (offset < file.size) {
        // ── Backpressure check ─────────────────────────────────────────
        if (channel.bufferedAmount > HIGH_WATERMARK) {
            log("Buffer full — pausing to drain…", "warn");
            await waitForDrain();
            log("Buffer drained — resuming…", "info");
        }

        // ── Read next chunk ────────────────────────────────────────────
        let chunk;
        try {
            chunk = await readChunk(offset);
        } catch (err) {
            log(`File read error: ${err.message}`, "error");
            resetTransferUI();
            return;
        }

        // Check channel is still open before sending
        if (channel.readyState !== "open") {
            log("Channel closed unexpectedly during send.", "error");
            resetTransferUI();
            return;
        }

        channel.send(chunk);

        offset += chunk.byteLength;
        bytesSent += chunk.byteLength;

        // ── Update UI ──────────────────────────────────────────────────
        const elapsed = (Date.now() - sendStartTime) / 1000;
        const speed = elapsed > 0 ? bytesSent / elapsed : 0;
        updateProgress(`Sending "${file.name}"…`, bytesSent, file.size, speed);
    }

    // ── Step 3: signal completion ─────────────────────────────────────
    channel.send(JSON.stringify({ type: "done" }));

    const totalTime = ((Date.now() - sendStartTime) / 1000).toFixed(1);
    log(`✅ "${file.name}" sent in ${totalTime}s (${formatBytes(file.size)}).`, "success");
    updateProgress("Transfer complete!", file.size, file.size, 0);
    resetTransferUI(true);
}

// ─────────────────────────────────────────────────────────────────────────────
// Receiver DataChannel Setup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sets up the data channel once the answerer side receives it via ondatachannel.
 * We must handle:
 *  - The first message as a JSON metadata frame
 *  - All subsequent ArrayBuffer messages as binary chunks
 *  - A final JSON {type:"done"} frame triggering download
 */
function setupReceiverChannel(channel, fromName) {
    channel.binaryType = "arraybuffer";

    channel.onopen = () => {
        log(`Channel open — ready to receive from "${fromName}".`, "info");
        isBusy = true;
    };

    channel.onmessage = (event) => {
        handleReceivedMessage(event.data, fromName);
    };

    channel.onerror = (e) => {
        log(`Receive error: ${e.message || "unknown"}`, "error");
        resetReceive();
        resetTransferUI();
    };

    channel.onclose = () => {
        log("Channel closed (receiver side).", "info");
        resetTransferUI();
    };
}

function handleReceivedMessage(data, fromName) {
    // ── JSON frames (metadata or done) ──────────────────────────────
    if (typeof data === "string") {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }

        if (msg.type === "metadata") {
            // Initialise receive state
            receive.active = true;
            receive.meta = { fileName: msg.fileName, fileSize: msg.fileSize, fileType: msg.fileType };
            receive.chunks = [];
            receive.received = 0;
            receive.startTime = Date.now();

            // Show the incoming file modal
            showIncomingModal(fromName, msg);
            log(`Incoming: "${msg.fileName}" (${formatBytes(msg.fileSize)}) from "${fromName}".`, "info");
            return;
        }

        if (msg.type === "done") {
            assembleAndDownload();
            return;
        }
        return;
    }

    // ── Binary chunks ────────────────────────────────────────────────
    if (!receive.active || !receive.meta) return;

    receive.chunks.push(data);
    receive.received += data.byteLength;

    const elapsed = (Date.now() - receive.startTime) / 1000;
    const speed = elapsed > 0 ? receive.received / elapsed : 0;
    updateProgress(
        `Receiving "${receive.meta.fileName}"…`,
        receive.received,
        receive.meta.fileSize,
        speed
    );

    // Check if we have all bytes (in case "done" message was lost / reordered,
    // though ordered channels guarantee ordering).
    if (receive.received >= receive.meta.fileSize) {
        assembleAndDownload();
    }
}

/**
 * Assembles buffered chunks into a Blob and triggers a browser download.
 * Memory is released immediately after the download is initiated.
 */
function assembleAndDownload() {
    if (!receive.meta || receive.chunks.length === 0) return;

    const { fileName, fileType, fileSize } = receive.meta;

    log(`Assembling "${fileName}" (${receive.chunks.length} chunks)…`, "info");

    const blob = new Blob(receive.chunks, { type: fileType });

    // Create a temporary object URL — must be revoked to free memory
    const url = URL.createObjectURL(blob);

    dom.downloadAnchor.href = url;
    dom.downloadAnchor.download = fileName;
    dom.downloadAnchor.click();

    // Revoke after 60 s to give the browser time to initiate the download
    setTimeout(() => URL.revokeObjectURL(url), 60_000);

    const totalTime = ((Date.now() - receive.startTime) / 1000).toFixed(1);
    log(`✅ "${fileName}" received in ${totalTime}s — downloaded!`, "success");
    updateProgress("Download complete!", fileSize, fileSize, 0);

    resetReceive();
    resetTransferUI(true);
}

function resetReceive() {
    receive.active = false;
    receive.meta = null;
    receive.chunks = [];
    receive.received = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Incoming File Modal
// ─────────────────────────────────────────────────────────────────────────────

function showIncomingModal(fromName, meta) {
    dom.modalFrom.textContent = `From: ${fromName}`;
    dom.modalFileName.textContent = meta.fileName;
    dom.modalFileSize.textContent = formatBytes(meta.fileSize);
    dom.incomingModal.hidden = false;
    dom.progressSection.hidden = false;
}

dom.btnAccept.addEventListener("click", () => {
    dom.incomingModal.hidden = true;
    log("File accepted — receiving…", "info");
});

dom.btnDecline.addEventListener("click", () => {
    dom.incomingModal.hidden = true;
    log("File declined.", "warn");
    closePeerConnection();
    resetReceive();
    resetTransferUI();
});

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup
// ─────────────────────────────────────────────────────────────────────────────

function closePeerConnection() {
    if (dataChannel) {
        try { dataChannel.close(); } catch { }
        dataChannel = null;
    }
    if (peerConnection) {
        try { peerConnection.close(); } catch { }
        peerConnection = null;
    }
    pendingCandidates = [];
}
