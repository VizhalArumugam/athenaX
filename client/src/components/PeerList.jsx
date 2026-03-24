import { getInitials } from "../utils";

export default function PeerList({ peers, selectedPeerId, onSelectPeer, connected }) {
  return (
    <section className="panel panel-peers" aria-label="Nearby receivers">
      <div className="panel-header">
        <h2 className="panel-title"><span className="panel-icon">📡</span>Nearby Receivers</h2>
        <span className="peer-count-badge">{peers.length}</span>
      </div>

      {peers.length === 0 && (
        <p className="hint-text visible">
          No receivers nearby. Ask the other device to open AthenaX and tap <strong>Receive</strong>.
        </p>
      )}

      <ul className="peer-list" aria-live="polite">
        {peers.map((peer) => (
          <li
            key={peer.id}
            className={`peer-item ${peer.id === selectedPeerId ? "selected" : ""}`}
            data-id={peer.id}
            onClick={() => onSelectPeer(peer.id, peer.name)}
          >
            <div className="peer-avatar">{getInitials(peer.name)}</div>
            <div className="peer-info">
              <div className="peer-name">{peer.name}</div>
              <div className="peer-status-text">Ready to receive</div>
            </div>
            <div className="peer-select-check" />
          </li>
        ))}
      </ul>

      <div className="server-status">
        <span className={`status-dot ${connected ? "connected" : "disconnected"}`} />
        <span className="status-text">
          {connected ? "Connected to server" : "Disconnected — reconnecting…"}
        </span>
      </div>
    </section>
  );
}
