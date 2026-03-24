import { useRef, useState, useCallback } from "react";
import { formatBytes } from "../utils";

const CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB
const MAX_INFLIGHT = 32;            // sliding-window slots

/**
 * useTransfer — handles both sending (sliding-window) and receiving (chunk assembly).
 *
 * Returns sender + receiver state and control functions.
 */
export default function useTransfer(socket) {
  // ── Sender state ──────────────────────────────────────────────
  const [sending, setSending] = useState(false);
  const [sendProgress, setSendProgress] = useState({
    label: "",
    done: 0,
    total: 0,
    speed: 0,
    pct: 0,
  });
  const [logs, setLogs] = useState([
    { msg: "🔒 Transfers are relayed securely through the server.", type: "info" },
  ]);
  const sendCancelRef = useRef(false);

  // ── Receiver state ────────────────────────────────────────────
  const [receiving, setReceiving] = useState(false);
  const [recvProgress, setRecvProgress] = useState({
    label: "",
    done: 0,
    total: 0,
    speed: 0,
    pct: 0,
  });
  const [receivedFiles, setReceivedFiles] = useState([]);
  const rxRef = useRef({ active: false, meta: null, chunks: [], received: 0, startTime: 0 });

  const addLog = useCallback((msg, type = "info") => {
    setLogs((prev) => [...prev, { msg, type }]);
  }, []);

  // ── SENDER: sliding-window file send ──────────────────────────
  const sendFile = useCallback(
    async (targetId, file, peerName) => {
      if (!socket) return;
      sendCancelRef.current = false;
      setSending(true);
      const startTime = Date.now();

      addLog(`Sending "${file.name}" (${formatBytes(file.size)}) to ${peerName}…`, "info");
      setSendProgress({ label: "Preparing…", done: 0, total: file.size, speed: 0, pct: 0 });

      // 1. Metadata
      socket.emit("transfer-request", {
        targetId,
        meta: {
          fileName: file.name,
          fileSize: file.size,
          fileType: file.type || "application/octet-stream",
        },
      });
      await new Promise((r) => setTimeout(r, 100));

      // 2. Sliding-window chunk loop
      let offset = 0;
      let chunkIndex = 0;
      let inFlight = 0;
      let cancelled = false;
      let loopDone = false;
      let lastUIMs = 0;

      let windowWaiter = null;
      const freeSlot = () => {
        inFlight--;
        if (windowWaiter) {
          const r = windowWaiter;
          windowWaiter = null;
          r();
        }
      };
      const waitForSlot = () => {
        if (inFlight < MAX_INFLIGHT) return Promise.resolve();
        return new Promise((r) => { windowWaiter = r; });
      };

      let resolveDone, rejectDone;
      const allAcked = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });

      (async () => {
        while (offset < file.size && !cancelled && !sendCancelRef.current) {
          await waitForSlot();
          if (cancelled || sendCancelRef.current) break;

          const end = Math.min(offset + CHUNK_SIZE, file.size);
          const chunk = await file.slice(offset, end).arrayBuffer().catch((e) => {
            addLog(`Read error: ${e.message}`, "error");
            cancelled = true;
            return null;
          });
          if (!chunk || cancelled) break;

          const idx = chunkIndex++;
          offset += chunk.byteLength;
          inFlight++;

          socket.emit("file-chunk", { targetId, chunk, chunkIndex: idx }, (ack) => {
            if (ack === "no-peer") {
              cancelled = true;
              rejectDone(new Error("no-peer"));
              return;
            }
            freeSlot();

            const now = Date.now();
            if (now - lastUIMs > 100) {
              lastUIMs = now;
              const elapsed = (now - startTime) / 1000;
              const speed = elapsed > 0 ? offset / elapsed : 0;
              const pct = Math.round((Math.min(offset, file.size) / file.size) * 100);
              setSendProgress({
                label: `Sending "${file.name}"…`,
                done: Math.min(offset, file.size),
                total: file.size,
                speed,
                pct,
              });
            }

            if (loopDone && inFlight === 0) resolveDone();
          });
        }
        loopDone = true;
        if (inFlight === 0 && !cancelled) resolveDone();
      })();

      try {
        await allAcked;
      } catch (e) {
        const msg =
          e.message === "no-peer"
            ? "Receiver disconnected during transfer."
            : `Transfer error: ${e.message}`;
        addLog(msg, "error");
        setSending(false);
        setSendProgress({ label: "", done: 0, total: 0, speed: 0, pct: 0 });
        return;
      }

      if (cancelled || sendCancelRef.current) {
        setSending(false);
        return;
      }

      // 3. Done signal
      socket.emit("transfer-done", { targetId });
      const sec = ((Date.now() - startTime) / 1000).toFixed(1);
      const avgSpd = formatBytes(file.size / parseFloat(sec));
      addLog(`✅ "${file.name}" sent in ${sec}s (avg ${avgSpd}/s)`, "success");
      setSendProgress({ label: "Transfer complete! ✅", done: file.size, total: file.size, speed: 0, pct: 100 });
      setSending(false);
    },
    [socket, addLog]
  );

  // ── RECEIVER: register socket listeners ───────────────────────
  const registerReceiver = useCallback(
    (onBusyChange) => {
      if (!socket) return () => {};

      const handleIncoming = ({ fromId, fromName, meta }) => {
        if (rxRef.current.active) {
          addLog(`Ignored transfer from ${fromName} — already busy.`, "warn");
          return;
        }
        rxRef.current = { active: true, meta, chunks: [], received: 0, startTime: Date.now() };
        setReceiving(true);
        onBusyChange?.(true);
        addLog(`Incoming: "${meta.fileName}" (${formatBytes(meta.fileSize)}) from "${fromName}"`, "info");
        setRecvProgress({ label: `Receiving "${meta.fileName}"…`, done: 0, total: meta.fileSize, speed: 0, pct: 0 });
      };

      const handleChunk = ({ chunk }) => {
        const rx = rxRef.current;
        if (!rx.active || !rx.meta) return;
        rx.chunks.push(chunk);
        rx.received += chunk.byteLength;

        const elapsed = (Date.now() - rx.startTime) / 1000;
        const speed = elapsed > 0 ? rx.received / elapsed : 0;
        const pct = Math.round((rx.received / rx.meta.fileSize) * 100);
        setRecvProgress({
          label: `Receiving "${rx.meta.fileName}"…`,
          done: rx.received,
          total: rx.meta.fileSize,
          speed,
          pct,
        });
      };

      const handleDone = () => {
        const rx = rxRef.current;
        if (!rx.meta || rx.chunks.length === 0) return;

        const { fileName, fileType, fileSize } = rx.meta;
        addLog(`Assembling "${fileName}"…`, "info");

        const blob = new Blob(rx.chunks, { type: fileType });
        const url = URL.createObjectURL(blob);

        // Auto-download
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        a.click();

        const sec = ((Date.now() - rx.startTime) / 1000).toFixed(1);
        addLog(`✅ "${fileName}" received in ${sec}s`, "success");
        setRecvProgress({ label: "Download complete! ✅", done: fileSize, total: fileSize, speed: 0, pct: 100 });

        setReceivedFiles((prev) => [
          { name: fileName, size: fileSize, type: fileType, url, timestamp: Date.now() },
          ...prev,
        ]);

        setTimeout(() => URL.revokeObjectURL(url), 300_000);

        rxRef.current = { active: false, meta: null, chunks: [], received: 0, startTime: 0 };
        setReceiving(false);
        onBusyChange?.(false);
      };

      const handleCancel = () => {
        addLog("Transfer cancelled by sender.", "warn");
        rxRef.current = { active: false, meta: null, chunks: [], received: 0, startTime: 0 };
        setReceiving(false);
        onBusyChange?.(false);
      };

      socket.on("transfer-incoming", handleIncoming);
      socket.on("file-chunk", handleChunk);
      socket.on("transfer-done", handleDone);
      socket.on("transfer-cancel", handleCancel);

      return () => {
        socket.off("transfer-incoming", handleIncoming);
        socket.off("file-chunk", handleChunk);
        socket.off("transfer-done", handleDone);
        socket.off("transfer-cancel", handleCancel);
      };
    },
    [socket, addLog]
  );

  const cancelSend = useCallback(() => {
    sendCancelRef.current = true;
  }, []);

  return {
    // sender
    sending,
    sendProgress,
    sendFile,
    cancelSend,
    // receiver
    receiving,
    recvProgress,
    receivedFiles,
    registerReceiver,
    // shared
    logs,
    addLog,
  };
}
