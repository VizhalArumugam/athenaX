import { useState } from "react";
import { formatBytes, formatTime } from "../utils";
import Lightbox from "./Lightbox";

function fileIcon(type) {
  if (type.startsWith("image/")) return "🖼️";
  if (type.startsWith("video/")) return "🎬";
  if (type.startsWith("audio/")) return "🎵";
  if (type === "application/pdf") return "📄";
  if (type.startsWith("text/")) return "📝";
  if (type.includes("zip") || type.includes("compressed")) return "🗜️";
  return "📦";
}

function FilePreview({ file }) {
  if (file.type.startsWith("image/")) {
    return <img src={file.url} alt={file.name} loading="lazy" />;
  }
  if (file.type.startsWith("video/")) {
    return <video src={file.url} muted preload="metadata" />;
  }
  if (file.type.startsWith("audio/")) {
    return <audio src={file.url} controls />;
  }
  return <span className="file-type-icon">{fileIcon(file.type)}</span>;
}

export default function FileGallery({ files }) {
  const [lightboxFile, setLightboxFile] = useState(null);

  if (files.length === 0) {
    return (
      <div className="files-gallery-section">
        <div className="gallery-header">
          <h3 className="gallery-title">📂 Received Files</h3>
          <span className="gallery-count">0 files</span>
        </div>
        <div className="gallery-empty">Files you receive will appear here.</div>
      </div>
    );
  }

  const previewable = (type) =>
    type.startsWith("image/") || type.startsWith("video/") || type === "application/pdf" || type.startsWith("text/");

  return (
    <div className="files-gallery-section">
      <div className="gallery-header">
        <h3 className="gallery-title">📂 Received Files</h3>
        <span className="gallery-count">{files.length} file{files.length !== 1 ? "s" : ""}</span>
      </div>
      <div className="gallery-grid">
        {files.map((file, i) => (
          <div key={i} className="file-card">
            <div
              className="file-card-preview"
              style={{ cursor: previewable(file.type) ? "pointer" : "default" }}
              onClick={() => previewable(file.type) && setLightboxFile(file)}
            >
              <FilePreview file={file} />
              {previewable(file.type) && <div className="preview-overlay">🔍 Preview</div>}
            </div>
            <div className="file-card-info">
              <div className="file-card-name" title={file.name}>{file.name}</div>
              <div className="file-card-meta">
                <span>{formatBytes(file.size)}</span>
                <span>{formatTime(file.timestamp)}</span>
              </div>
            </div>
            <div className="file-card-actions">
              <button
                className="btn-card btn-download"
                onClick={() => {
                  const a = document.createElement("a");
                  a.href = file.url;
                  a.download = file.name;
                  a.click();
                }}
              >
                ⬇ Download
              </button>
              {previewable(file.type) && (
                <button className="btn-card" onClick={() => setLightboxFile(file)}>
                  🔍 View
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {lightboxFile && <Lightbox file={lightboxFile} onClose={() => setLightboxFile(null)} />}
    </div>
  );
}
