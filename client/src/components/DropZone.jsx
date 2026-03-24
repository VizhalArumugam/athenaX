import { useRef, useState, useCallback } from "react";
import { formatBytes } from "../utils";

export default function DropZone({ onFileSelected, disabled }) {
  const inputRef = useRef(null);
  const [fileName, setFileName] = useState(null);
  const [fileSize, setFileSize] = useState(null);
  const [dragOver, setDragOver] = useState(false);

  const handleFile = useCallback(
    (file) => {
      if (!file) return;
      setFileName(file.name);
      setFileSize(file.size);
      onFileSelected(file);
    },
    [onFileSelected]
  );

  return (
    <div
      className={`drop-zone ${fileName ? "has-file" : ""} ${dragOver ? "drag-over" : ""}`}
      tabIndex="0"
      role="button"
      aria-label="Select or drop a file"
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") inputRef.current?.click(); }}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
      }}
    >
      <div className="drop-zone-inner">
        <div className="drop-icon">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <polyline points="17 8 12 3 7 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <line x1="12" y1="3" x2="12" y2="15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </div>
        <p className="drop-primary">Drag &amp; drop a file here</p>
        <p className="drop-secondary">or click to browse — any size supported</p>
        {fileName && <p className="drop-file-name">{fileName}  ({formatBytes(fileSize)})</p>}
      </div>
      <input
        ref={inputRef}
        type="file"
        className="file-input-hidden"
        aria-hidden="true"
        tabIndex="-1"
        onChange={(e) => { if (e.target.files[0]) handleFile(e.target.files[0]); }}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
