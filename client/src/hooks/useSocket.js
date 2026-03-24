import { useEffect, useRef, useState, useCallback } from "react";
import { io } from "socket.io-client";

/**
 * useSocket — manages the Socket.IO connection, identity, and peer list.
 *
 * Returns:
 *  { socket, myId, myName, connected, peers, mode, setMode, resetMode }
 */
export default function useSocket() {
  const socketRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const [myId, setMyId] = useState(null);
  const [myName, setMyName] = useState(null);
  const [mode, setModeState] = useState(null); // "sender" | "receiver" | null
  const [peers, setPeers] = useState([]);

  useEffect(() => {
    const s = io({ transports: ["websocket", "polling"] });
    socketRef.current = s;

    s.on("connect", () => setConnected(true));
    s.on("disconnect", () => setConnected(false));
    s.on("self-identity", ({ id, name }) => {
      setMyId(id);
      setMyName(name);
    });
    s.on("mode-confirmed", () => {});
    s.on("peer-list", (list) => setPeers(list));

    return () => {
      s.disconnect();
      socketRef.current = null;
    };
  }, []);

  const setMode = useCallback(
    (m) => {
      if (!socketRef.current) return;
      socketRef.current.emit("set-mode", m);
      setModeState(m);
    },
    []
  );

  const resetMode = useCallback(() => {
    setModeState(null);
    setPeers([]);
  }, []);

  return {
    socket: socketRef.current,
    myId,
    myName,
    connected,
    peers,
    mode,
    setMode,
    resetMode,
  };
}
