export default function Header({ myName, connected }) {
  return (
    <header className="app-header">
      <div className="logo-area">
        <div className="logo-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" fill="url(#lg)" />
            <defs>
              <linearGradient id="lg" x1="3" y1="2" x2="21" y2="22" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#a78bfa" />
                <stop offset="100%" stopColor="#38bdf8" />
              </linearGradient>
            </defs>
          </svg>
        </div>
        <div className="logo-text">
          <span className="logo-name">AthenaX</span>
          <span className="logo-tagline">Peer-to-Peer File Transfer</span>
        </div>
      </div>
      <div className="self-identity">
        <span className="identity-label">Your Device:</span>
        <span className="identity-name">{myName ?? "Connecting…"}</span>
        <span className={`status-dot-inline ${connected ? "connected" : ""}`} />
      </div>
    </header>
  );
}
