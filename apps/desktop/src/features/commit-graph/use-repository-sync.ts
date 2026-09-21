import { invoke, isDesktop } from "@/lib/ipc"
import { saveSetting } from "@/lib/settings"
import { listen } from "@tauri-apps/api/event"
import { useCallback, useEffect, useRef, useState } from "react"

import {
  autoFetchSetting,
  completedKinds,
  createClientId,
  FOCUS_DEBOUNCE,
  SYNCED_EVENT,
  WATCH_INTERVAL,
  type SyncKind,
  type SyncReason,
  type SyncStatus,
} from "./repository-sync"

type SyncedEvent = { projectId: string; kind: SyncKind; status: SyncStatus }

/**
 * Registers this window as a watcher of its repository so the backend keeps the remotes and GitHub
 * fresh on the repository's behalf, and reports each completed run through `onSynced`.
 */
export function useRepositorySync({
  onSynced,
  repoPath,
}: {
  onSynced: (kind: SyncKind, status: SyncStatus) => void
  repoPath: string
}) {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const latestStatus = useRef<SyncStatus | null>(null)
  const latestOnSynced = useRef(onSynced)
  useEffect(() => {
    latestOnSynced.current = onSynced
  }, [onSynced])

  const applyStatus = useCallback((next: SyncStatus) => {
    const completed = completedKinds(latestStatus.current, next)
    latestStatus.current = next
    setStatus(next)
    for (const kind of completed) {
      latestOnSynced.current(kind, next)
    }
  }, [])

  const refresh = useCallback(
    (reason: SyncReason) =>
      invoke<SyncStatus>("refresh_repository", { repoPath, reason }).then(
        (next) => {
          applyStatus(next)
          return next
        },
      ),
    [applyStatus, repoPath],
  )

  useEffect(() => {
    let disposed = false
    let focusTimeout: number | null = null
    const clientId = createClientId()
    latestStatus.current = null
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus(null)
    const watch = () =>
      invoke<SyncStatus>("watch_repository", {
        clientId,
        isVisible: !document.hidden,
        repoPath,
      })
        .then((next) => {
          if (!disposed) {
            applyStatus(next)
          }
        })
        .catch(() => undefined)
    const refreshOnFocus = () => {
      if (focusTimeout !== null) {
        window.clearTimeout(focusTimeout)
      }
      focusTimeout = window.setTimeout(() => {
        focusTimeout = null
        if (!document.hidden) {
          refresh("focus").catch(() => undefined)
        }
      }, FOCUS_DEBOUNCE)
    }
    const watchOnVisibility = () => {
      void watch()
      if (!document.hidden) {
        refreshOnFocus()
      }
    }

    void watch()
    const interval = window.setInterval(watch, WATCH_INTERVAL)
    window.addEventListener("focus", refreshOnFocus)
    document.addEventListener("visibilitychange", watchOnVisibility)
    let unlisten: (() => void) | undefined
    if (isDesktop) {
      void listen<SyncedEvent>(SYNCED_EVENT, ({ payload }) => {
        if (payload.projectId === latestStatus.current?.projectId) {
          applyStatus(payload.status)
        }
      })
        .then((dispose) => {
          if (disposed) {
            dispose()
          } else {
            unlisten = dispose
          }
        })
        .catch(() => undefined)
    }
    return () => {
      disposed = true
      window.clearInterval(interval)
      if (focusTimeout !== null) {
        window.clearTimeout(focusTimeout)
      }
      window.removeEventListener("focus", refreshOnFocus)
      document.removeEventListener("visibilitychange", watchOnVisibility)
      unlisten?.()
      invoke("unwatch_repository", { clientId }, { keepalive: true }).catch(
        () => undefined,
      )
    }
  }, [applyStatus, refresh, repoPath])

  const setAutoFetch = useCallback(
    async (enabled: boolean) => {
      const current = latestStatus.current
      if (!current) {
        return
      }
      await saveSetting(autoFetchSetting(current.projectId), enabled)
      setStatus((current) => current && { ...current, autoFetch: enabled })
      return refresh("focus").catch(() => undefined)
    },
    [refresh],
  )

  return { refresh, setAutoFetch, status }
}
