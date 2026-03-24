// Utility functions shared across components

export function formatBytes(b) {
  if (b === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return `${(b / k ** i).toFixed(1)} ${sizes[i]}`;
}

export function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function getInitials(name) {
  const parts = name.split("-");
  return (parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "");
}
