import { useState } from "react";
import PeerList from "./PeerList";
import DropZone from "./DropZone";
import ProgressBar from "./ProgressBar";
import StatusLog from "./StatusLog";

export default function SenderView({
  peers,
  connected,
  sendProgress,
  sending,
  logs,
  onSendFile,
  onChangeMode,
}) {
  const [selectedPeerId, setSelectedPeerId] = useState(null);
  const [selectedPeerName, setSelectedPeerName] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null);

  const handleSelectPeer = (id, name) => {
    setSelectedPeerId(id);
    setSelectedPeerName(name);
  };

  const handleFileSelected = (file) => {
    setSelectedFile(file);
  };

  const handleSend = () => {
    if (!selectedPeerId || !selectedFile || sending) return;
    onSendFile(selectedPeerId, selectedFile, selectedPeerName);
  };

  // Clear selection if selected peer left
  const peerStillExists = peers.some((p) => p.id === selectedPeerId);
  if (selectedPeerId && !peerStillExists && !sending) {
    // Will be handled on next render
    if (selectedPeerId) {
      setTimeout(() => {
        setSelectedPeerId(null);
        setSelectedPeerName(null);
      }, 0);
    }
  }

  return (
    <div className="app-grid">
      <PeerList
        peers={peers}
        selectedPeerId={selectedPeerId}
        onSelectPeer={handleSelectPeer}
        connected={connected}
      />

      <section className="panel panel-transfer" aria-label="Send a file">
        <div className="panel-header">
          <h2 className="panel-title"><span className="panel-icon">📁</span>Send a File</h2>
          <button className="btn-ghost" onClick={onChangeMode} title="Change mode">⇄ Change</button>
        </div>

        <div className="selected-peer-display">
          <span className="selected-peer-label">Sending to:</span>
          <span className="selected-peer-name">
            {selectedPeerName || "None — pick a receiver"}
          </span>
        </div>

        <DropZone onFileSelected={handleFileSelected} disabled={sending} />

        <button
          className="btn btn-send"
          disabled={!selectedPeerId || !selectedFile || sending}
          onClick={handleSend}
        >
          <span>⚡</span> Send File
        </button>

        {(sending || sendProgress.pct > 0) && (
          <ProgressBar {...sendProgress} />
        )}

        <StatusLog logs={logs} />
      </section>
    </div>
  );
}
