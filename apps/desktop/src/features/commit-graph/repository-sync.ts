export type SyncKind = "fetch" | "pullRequests"

export type SyncReason = "manual" | "focus"

export type TrackStatus = {
  isRunning: boolean
  completedAt: number | null
  succeededAt: number | null
  error: string | null
}

export type SyncStatus = {
  projectId: string
  autoFetch: boolean
  fetch: TrackStatus
  pullRequests: TrackStatus
}

export const SYNCED_EVENT = "repository-synced"
export function autoFetchSetting(projectId: string) {
  return `sync.autoFetch:${projectId}`
}
/** How often a window renews its watch; the backend forgets a watcher that misses three renewals. */
export const WATCH_INTERVAL = 20_000
export const FOCUS_DEBOUNCE = 150

const KINDS: SyncKind[] = ["fetch", "pullRequests"]

/** The kinds whose run finished between two readings of the status. */
export function completedKinds(
  previous: SyncStatus | null,
  next: SyncStatus,
): SyncKind[] {
  return KINDS.filter((kind) => {
    const track = next[kind]
    return (
      track.completedAt !== null &&
      track.completedAt !== (previous?.[kind].completedAt ?? null)
    )
  })
}

export function createClientId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  )
}
