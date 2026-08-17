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
const DELETED_SESSIONS_KEY = "nextchat-d1-deleted-sessions";

type DeletedSessions = Record<string, number>;
type D1ChatSyncState = ChatSyncState & {
  deletedSessions?: DeletedSessions;
};

function loadDeletedSessions(): DeletedSessions {
  try {
    if (typeof window === "undefined") return {};
    const raw = window.localStorage.getItem(DELETED_SESSIONS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveDeletedSessions(deletedSessions: DeletedSessions) {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      DELETED_SESSIONS_KEY,
      JSON.stringify(deletedSessions),
    );
  } catch (error) {
    console.warn("[D1 Sync] failed to persist deletion tombstones", error);
  }
}

function mergeDeletedSessions(
  localDeleted: DeletedSessions,
  remoteDeleted: DeletedSessions,
) {
  const merged = { ...localDeleted };
  Object.entries(remoteDeleted).forEach(([sessionId, deletedAt]) => {
    const timestamp = Number(deletedAt) || 0;
    if (timestamp > (merged[sessionId] ?? 0)) {
      merged[sessionId] = timestamp;
    }
  });
  return merged;
}

function filterDeletedSessions<T extends { sessions: { id: string }[] }>(
  state: T,
  deletedSessions: DeletedSessions,
): T {
  return {
    ...state,
    sessions: state.sessions.filter((session) => !deletedSessions[session.id]),
  };
}

function buildLocalSyncState(): D1ChatSyncState {
  return {
    ...getLocalChatState(),
    deletedSessions: loadDeletedSessions(),
  };
}

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
    let knownSessionIds = new Set<string>();

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
        const serialized = JSON.stringify(buildLocalSyncState());
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

    const trackLocalSessionChanges = (sessions: { id: string }[]) => {
      const currentIds = new Set(sessions.map((session) => session.id));
      const deletedSessions = loadDeletedSessions();
      const deletedAt = Date.now();
      let changed = false;

      // A session that disappeared locally is a real deletion, not merely an
      // absent remote record. Persist a tombstone immediately so even a page
      // refresh before the next D1 upload cannot resurrect it.
      knownSessionIds.forEach((sessionId) => {
        if (!currentIds.has(sessionId)) {
          deletedSessions[sessionId] = Math.max(
            deletedSessions[sessionId] ?? 0,
            deletedAt,
          );
          changed = true;
        }
      });

      // NextChat's delete action has a short Undo window. If the same session
      // ID reappears locally before the tombstone is synced, treat that as an
      // undo and remove the local tombstone.
      currentIds.forEach((sessionId) => {
        if (!knownSessionIds.has(sessionId) && deletedSessions[sessionId]) {
          delete deletedSessions[sessionId];
          changed = true;
        }
      });

      if (changed) saveDeletedSessions(deletedSessions);
      knownSessionIds = currentIds;
      return changed;
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

        const remote = JSON.parse(serialized) as D1ChatSyncState;
        if (!remote?.sessions) return true;

        const deletedSessions = mergeDeletedSessions(
          loadDeletedSessions(),
          remote.deletedSessions ?? {},
        );
        saveDeletedSessions(deletedSessions);

        applyingRemote = true;
        try {
          // Tombstones are applied before the normal session/message merge.
          // This makes deletion win over an old D1 snapshot and prevents the
          // deleted conversation from appearing again after refresh or on a
          // second browser.
          const local = filterDeletedSessions(
            getLocalChatState(),
            deletedSessions,
          );
          const remoteChatState = filterDeletedSessions(
            remote,
            deletedSessions,
          ) as ChatSyncState;
          const merged = mergeChatState(local, remoteChatState);
          merged.sessions = merged.sessions.filter(
            (session) => !deletedSessions[session.id],
          );
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

      // Capture the local IDs before pulling. This lets a deletion that was
      // made shortly before a refresh remain represented by its localStorage
      // tombstone while the stale D1 snapshot is being merged.
      knownSessionIds = new Set(
        useChatStore.getState().sessions.map((session) => session.id),
      );

      const reachable = await pull();
      if (disposed) return;

      ready = reachable;
      if (!ready) return;

      knownSessionIds = new Set(
        useChatStore.getState().sessions.map((session) => session.id),
      );

      unsubscribe = useChatStore.subscribe((state) => {
        trackLocalSessionChanges(state.sessions);
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
