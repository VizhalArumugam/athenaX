import { useEffect, useRef, useCallback } from "react";

/**
 * useNavigationGuard — prevents accidental page close/swipe-back during transfers.
 *
 * Uses History API pushState for mobile swipe-back interception
 * and beforeunload for desktop refresh/close.
 *
 * @param {boolean} isBusy — whether a transfer is in progress
 * @param {string|null} mode — current mode ("sender"|"receiver"|null)
 * @param {function} onExitRequest — called when user attempts to exit during transfer
 */
export default function useNavigationGuard(isBusy, mode, onExitRequest) {
  const guardPushed = useRef(false);

  // Push initial guard state on mount
  useEffect(() => {
    if (!guardPushed.current) {
      history.replaceState({ athenaxMark: true }, "");
      history.pushState({ athenaxGuard: true }, "");
      guardPushed.current = true;
    }
  }, []);

  // popstate handler
  useEffect(() => {
    const handlePopstate = () => {
      if (isBusy) {
        history.pushState({ athenaxGuard: true }, "");
        onExitRequest?.();
        return;
      }
      if (mode !== null) {
        history.pushState({ athenaxGuard: true }, "");
        return;
      }
      // mode === null → let user leave
    };

    window.addEventListener("popstate", handlePopstate);
    return () => window.removeEventListener("popstate", handlePopstate);
  }, [isBusy, mode, onExitRequest]);

  // beforeunload for desktop
  useEffect(() => {
    const handleBeforeUnload = (e) => {
      if (!isBusy) return;
      e.preventDefault();
      e.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isBusy]);

  const exitAndNavigate = useCallback(() => {
    history.go(-2);
  }, []);

  return { exitAndNavigate };
}
