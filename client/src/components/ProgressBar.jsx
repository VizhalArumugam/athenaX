import { formatBytes } from "../utils";

export default function ProgressBar({ label, done, total, speed, pct }) {
  return (
    <div className="progress-section">
      <div className="progress-header">
        <span className="progress-label">{label}</span>
        <span className="progress-percent">{pct}%</span>
      </div>
      <div className="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={pct}>
        <div className="progress-bar" style={{ width: `${pct}%` }} />
      </div>
      <div className="progress-meta">
        <span>{formatBytes(done)} / {formatBytes(total)}</span>
        <span>{speed ? `${formatBytes(speed)}/s` : "-- B/s"}</span>
      </div>
    </div>
  );
}
