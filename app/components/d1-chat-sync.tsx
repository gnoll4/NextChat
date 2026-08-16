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
const PUSH_DEBOUNCE_MS = 20_000;
const FOCUS_PULL_MIN_INTERVAL_MS = 60_000;

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
        // Serialize in the browser and send the JSON string directly. The
        // Worker stores this payload as opaque text, avoiding large JSON parse
        // and stringify work on Cloudflare's CPU budget.
        const serialized = JSON.stringify(getLocalChatState());
        const response = await fetch(SYNC_API, {
          method: "POST",
          headers: {
            "Content-Type": "application/json; charset=utf-8",
          },
          body: serialized,
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
          schedulePush();
        }
      }
    };

    const schedulePush = () => {
      if (!ready || applyingRemote || disposed) return;
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = setTimeout(() => {
        pushTimer = undefined;
        void push();
      }, PUSH_DEBOUNCE_MS);
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

        // 204 means this Access user has no remote snapshot yet.
        if (response.status === 204) {
          return true;
        }

        if (!response.ok) {
          const text = await response.text();
          console.warn("[D1 Sync] download failed", response.status, text);
          return false;
        }

        const serialized = await response.text();
        if (!serialized || disposed) return true;

        const remote = JSON.parse(serialized) as ChatSyncState;
        if (!remote?.sessions) return true;

        applyingRemote = true;
        try {
          const local = getLocalChatState();
          const merged = mergeChatState(local, remote);
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
        // Do not force an immediate full-state upload when the tab is hidden.
        // Keep the normal debounce so rapid tab switching cannot hammer D1.
        schedulePush();
      }
    };

    const bootstrap = async () => {
      await waitForChatHydration();
      if (disposed) return;

      const reachable = await pull();
      if (disposed) return;

      ready = reachable;
      if (!ready) return;

      unsubscribe = useChatStore.subscribe(() => {
        schedulePush();
      });

      window.addEventListener("focus", onFocus);
      document.addEventListener("visibilitychange", onVisibilityChange);

      // If this browser has local chats that are not yet in D1, upload the
      // merged snapshot later instead of immediately during page startup.
      schedulePush();

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
