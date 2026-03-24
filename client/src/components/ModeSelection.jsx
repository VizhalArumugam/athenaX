export default function ModeSelection({ onSelectMode }) {
  return (
    <div className="mode-screen">
      <div className="mode-screen-inner">
        <h1 className="mode-headline">What do you want to do?</h1>
        <p className="mode-subtext">
          Choose your role for this session. Both devices must be on AthenaX.
        </p>
        <div className="mode-cards">
          <button className="mode-card" onClick={() => onSelectMode("sender")} aria-label="Send files">
            <div className="mode-card-icon mode-card-icon--send">
              <svg viewBox="0 0 24 24" fill="none">
                <path d="M22 2L11 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <path d="M22 2L15 22l-4-9-9-4 20-7z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <span className="mode-card-title mode-card-title--send">Send</span>
            <span className="mode-card-desc">Pick a nearby receiver and send a file directly.</span>
            <div className="mode-card-glow mode-card-glow--send" />
          </button>

          <button className="mode-card" onClick={() => onSelectMode("receiver")} aria-label="Receive files">
            <div className="mode-card-icon mode-card-icon--recv">
              <svg viewBox="0 0 24 24" fill="none">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <polyline points="7 10 12 15 17 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <line x1="12" y1="15" x2="12" y2="3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </div>
            <span className="mode-card-title mode-card-title--recv">Receive</span>
            <span className="mode-card-desc">Make your device visible and wait for an incoming file.</span>
            <div className="mode-card-glow mode-card-glow--receive" />
          </button>
        </div>
      </div>
    </div>
  );
}
