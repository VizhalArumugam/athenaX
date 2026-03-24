export default function ExitModal({ visible, onStay, onLeave }) {
  if (!visible) return null;

  return (
    <div className="exit-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="exit-modal-title">
      <div className="exit-modal-card">
        <div className="exit-modal-icon">⚠️</div>
        <h3 className="exit-modal-title" id="exit-modal-title">Transfer in Progress</h3>
        <p className="exit-modal-desc">Do you want to cancel the file transfer and exit?</p>
        <div className="exit-modal-actions">
          <button className="btn exit-btn-stay" onClick={onStay}>
            ↩ Continue Transfer
          </button>
          <button className="btn exit-btn-leave" onClick={onLeave}>
            ✕ Cancel &amp; Exit
          </button>
        </div>
      </div>
    </div>
  );
}
