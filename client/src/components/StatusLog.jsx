import { useRef, useEffect } from "react";

export default function StatusLog({ logs }) {
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  return (
    <div className="status-log">
      {logs.map((entry, i) => (
        <p key={i} className={`log-entry log-${entry.type}`}>
          {entry.msg}
        </p>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
