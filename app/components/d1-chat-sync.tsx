"use client";

import { useEffect } from "react";
import { useChatStore } from "../store";
import {
  ChatSyncState,
  getLocalChatState,
  mergeChatState,
  setLocalChatState,
} from "../utils/sync";

const SYNC_API = "/api/sync/d1";
const PUSH_DEBOUNCE_MS = 5000;
const FOCUS_PULL_MIN_INTERVAL_MS = 15000;

type RemoteSyncResponse = {
  state: ChatSyncState | null;
  updatedAt: number;
};

async function waitForChatHydration() {
  if (useChatStore.getState()._hasHydrated) return;

  await new Promise<void>((resolve) => {
    const unsubscribe = useChatStore.subscribe((state) => {
      if (state._hasHydrated) {
        unsubscribe();
        resolve();
      }
    });
  });
}

export function D1ChatSync() {
  useEffect(() => {
    let disposed = false;
    let ready = false;
    let applyingRemote = false;
    let pushTimer: ReturnType<typeof setTimeout> | undefined;
    let pushInFlight = false;
    let pushAgain = false;
    let lastPullAt = 0;
    let unsubscribe: (() => void) | undefined;

    const push = async () => {
      if (disposed || !ready || applyingRemote) return;

      if (pushInFlight) {
        pushAgain = true;
        return;
      }

      pushInFlight = true;
      try {
        const state = getLocalChatState();
        const response = await fetch(SYNC_API, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ state }),
          cache: "no-store",
        });

        if (!response.ok) {
          const text = await response.text();
          console.warn("[D1 Sync] upload failed", response.status, text);
        }
      } catch (error) {
        console.warn("[D1 Sync] upload failed", error);
      } finally {
        pushInFlight = false;
        if (pushAgain && !disposed) {
          pushAgain = false;
          void push();
        }
      }
    };

    const schedulePush = () => {
      if (!ready || applyingRemote || disposed) return;
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = setTimeout(() => void push(), PUSH_DEBOUNCE_MS);
    };

    const pull = async () => {
      if (disposed) return false;

      try {
        const response = await fetch(SYNC_API, {
          method: "GET",
          cache: "no-store",
        });

        lastPullAt = Date.now();

        if (response.status === 401) {
          console.warn(
            "[D1 Sync] Cloudflare Access identity is unavailable; cross-device sync is disabled on this origin.",
          );
          return false;
        }

        if (!response.ok) {
          const text = await response.text();
          console.warn("[D1 Sync] download failed", response.status, text);
          return false;
        }

        const remote = (await response.json()) as RemoteSyncResponse;
        if (!remote.state || disposed) return true;

        applyingRemote = true;
        try {
          const local = getLocalChatState();
          const merged = mergeChatState(local, remote.state);
          setLocalChatState(merged);
        } finally {
          applyingRemote = false;
        }

        return true;
      } catch (error) {
        console.warn("[D1 Sync] download failed", error);
        return false;
      }
    };

    const onFocus = () => {
      if (
        ready &&
        Date.now() - lastPullAt >= FOCUS_PULL_MIN_INTERVAL_MS
      ) {
        void pull();
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        onFocus();
      } else if (ready) {
        // Best effort: start an upload when leaving the tab. Normal changes are
        // already debounced, so this mainly shortens the unsynced window.
        void push();
      }
    };

    const bootstrap = async () => {
      await waitForChatHydration();
      if (disposed) return;

      const reachable = await pull();
      if (disposed) return;

      ready = reachable;
      if (!ready) return;

      // Persist the merged state back to D1 so the server becomes the common
      // snapshot for the next browser/device.
      await push();
      if (disposed) return;

      unsubscribe = useChatStore.subscribe(() => {
        schedulePush();
      });

      window.addEventListener("focus", onFocus);
      document.addEventListener("visibilitychange", onVisibilityChange);

      console.log("[D1 Sync] automatic chat sync enabled");
    };

    void bootstrap();

    return () => {
      disposed = true;
      if (pushTimer) clearTimeout(pushTimer);
      unsubscribe?.();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return null;
}
