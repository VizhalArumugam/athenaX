import { useEffect } from "react";
import ProgressBar from "./ProgressBar";
import FileGallery from "./FileGallery";

export default function ReceiverView({
  myName,
  receiving,
  recvProgress,
  receivedFiles,
  registerReceiver,
  onChangeMode,
  onBusyChange,
}) {
  // Register socket listeners for receiving
  useEffect(() => {
    const cleanup = registerReceiver(onBusyChange);
    return cleanup;
  }, [registerReceiver, onBusyChange]);

  return (
    <div>
      {/* Waiting card */}
      <div className="receiver-waiting-card">
        <div className="receiver-pulse-ring" />
        <div className="receiver-inner">
          <div className="receiver-icon">📥</div>
          <h2 className="receiver-title">Waiting for sender…</h2>
          <p className="receiver-desc">Your device is now visible to nearby senders as:</p>
          <div className="receiver-name-badge">{myName ?? "—"}</div>
          <p className="receiver-hint">
            Ask the sender to open AthenaX, tap <strong>Send</strong>, and select your device.
          </p>
          <button className="btn-ghost" onClick={onChangeMode} style={{ marginTop: "1.25rem" }}>
            ⇄ Change Mode
          </button>
        </div>
      </div>

      {/* Progress */}
      {(receiving || recvProgress.pct > 0) && (
        <div className="recv-progress-card">
          <ProgressBar {...recvProgress} />
        </div>
      )}

      {/* Gallery */}
      <FileGallery files={receivedFiles} />
    </div>
  );
}
