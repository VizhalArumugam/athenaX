import { useState, useCallback } from "react";
import Header from "./components/Header";
import ModeSelection from "./components/ModeSelection";
import SenderView from "./components/SenderView";
import ReceiverView from "./components/ReceiverView";
import ExitModal from "./components/ExitModal";
import useSocket from "./hooks/useSocket";
import useTransfer from "./hooks/useTransfer";
import useNavigationGuard from "./hooks/useNavigationGuard";
import "./App.css";

export default function App() {
  const { socket, myId, myName, connected, peers, mode, setMode, resetMode } = useSocket();
  const {
    sending,
    sendProgress,
    sendFile,
    cancelSend,
    receiving,
    recvProgress,
    receivedFiles,
    registerReceiver,
    logs,
    addLog,
  } = useTransfer(socket);

  const [showExitModal, setShowExitModal] = useState(false);
  const isBusy = sending || receiving;

  const handleExitRequest = useCallback(() => {
    setShowExitModal(true);
  }, []);

  const { exitAndNavigate } = useNavigationGuard(isBusy, mode, handleExitRequest);

  const handleSelectMode = (m) => {
    setMode(m);
  };

  const handleChangeMode = () => {
    if (isBusy) return;
    resetMode();
    if (socket) socket.emit("set-mode", "none");
  };

  const handleBusyChange = useCallback(() => {}, []);

  const handleExitStay = () => setShowExitModal(false);

  const handleExitLeave = () => {
    setShowExitModal(false);
    cancelSend();
    if (socket) {
      socket.emit("transfer-cancel", { targetId: null });
    }
    exitAndNavigate();
  };

  return (
    <>
      <Header myName={myName} connected={connected} />

      {mode === null && <ModeSelection onSelectMode={handleSelectMode} />}

      {mode !== null && (
        <main className="app-main">
          {mode === "sender" && (
            <SenderView
              peers={peers}
              connected={connected}
              sendProgress={sendProgress}
              sending={sending}
              logs={logs}
              onSendFile={sendFile}
              onChangeMode={handleChangeMode}
            />
          )}

          {mode === "receiver" && (
            <ReceiverView
              myName={myName}
              receiving={receiving}
              recvProgress={recvProgress}
              receivedFiles={receivedFiles}
              registerReceiver={registerReceiver}
              onChangeMode={handleChangeMode}
              onBusyChange={handleBusyChange}
            />
          )}
        </main>
      )}

      <ExitModal
        visible={showExitModal}
        onStay={handleExitStay}
        onLeave={handleExitLeave}
      />
    </>
  );
}
