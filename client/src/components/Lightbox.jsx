export default function Lightbox({ file, onClose }) {
  if (!file) return null;

  let content;
  if (file.type.startsWith("image/")) {
    content = <img src={file.url} alt={file.name} />;
  } else if (file.type.startsWith("video/")) {
    content = <video src={file.url} controls autoPlay />;
  } else if (file.type === "application/pdf") {
    content = <iframe src={file.url} title={file.name} />;
  } else {
    content = (
      <div className="lightbox-text">
        Cannot preview "{file.name}"<br />
        Type: {file.type}<br />
        Size: {file.size}
      </div>
    );
  }

  return (
    <div className="lightbox" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <button className="lightbox-close" onClick={onClose} aria-label="Close preview">✕</button>
      <div className="lightbox-body">
        {content}
      </div>
    </div>
  );
}
