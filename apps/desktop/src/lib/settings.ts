import { toast } from "@workspace/shadcn/components/sonner"
import { listen } from "@tauri-apps/api/event"
import { useCallback, useEffect, useSyncExternalStore } from "react"

import { invoke, isDesktop } from "@/lib/ipc"

const SETTINGS_CLIENT_ID_KEY = "git-nav.settings.client-id"
const DESKTOP_CLIENT_ID = "desktop"
const SETTING_CHANGED_EVENT = "setting-changed"

type ClientIdStorage = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

type Setting = [key: string, value: unknown]

type SettingsStoreOptions<Value, Change> = {
  apply: (value: Value, clientId: string, key: string, setting: unknown) => Value
  changes: (change: Change, clientId: string) => Setting[]
  load: (clientId: string, onSaveError: (error: unknown) => void) => Promise<Value>
  saveErrorMessage: string
  syncErrorMessage: string
  update: (value: Value, change: Change) => Value
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function createSettingsClientId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function settingsClientId(
  desktop: boolean,
  storage: ClientIdStorage,
  createId: () => string = createSettingsClientId
) {
  if (desktop) {
    return DESKTOP_CLIENT_ID
  }
  try {
    const existing = storage.getItem(SETTINGS_CLIENT_ID_KEY)
    if (existing) {
      return existing
    }
  } catch {
    return createId()
  }
  const id = createId()
  try {
    storage.setItem(SETTINGS_CLIENT_ID_KEY, id)
  } catch {
    return id
  }
  return id
}

export function loadSettings() {
  return invoke<Record<string, unknown>>("settings")
}

export function saveSetting(key: string, value: unknown) {
  return invoke<void>("set_setting", { key, value })
}

export function createSettingsStore<Value, Change>({
  apply,
  changes,
  load,
  saveErrorMessage,
  syncErrorMessage,
  update,
}: SettingsStoreOptions<Value, Change>) {
  let sharedValue: Value | null = null
  let sharedValuePromise: Promise<Value> | null = null
  let sharedWrite = Promise.resolve()
  let sharedClientId: string | null = null
  const subscribers = new Set<() => void>()
  const pendingChanges = new Map<string, unknown>()
  const inFlightWrites = new Map<string, number>()

  function publish(value: Value) {
    sharedValue = value
    for (const subscriber of subscribers) {
      subscriber()
    }
  }

  function subscribe(subscriber: () => void) {
    subscribers.add(subscriber)
    return () => subscribers.delete(subscriber)
  }

  function snapshot() {
    return sharedValue
  }

  function clientId() {
    sharedClientId ??= settingsClientId(isDesktop, localStorage)
    return sharedClientId
  }

  function finishWrite(key: string) {
    const count = inFlightWrites.get(key)
    if (count === 1) {
      inFlightWrites.delete(key)
      return
    }
    if (count) {
      inFlightWrites.set(key, count - 1)
    }
  }

  function receiveChange({ payload }: { payload: unknown }) {
    if (!isObject(payload) || typeof payload.key !== "string") {
      return
    }
    if (inFlightWrites.has(payload.key)) {
      return
    }
    const currentClientId = clientId()
    if (!sharedValue) {
      pendingChanges.set(payload.key, payload.value)
      return
    }
    const next = apply(sharedValue, currentClientId, payload.key, payload.value)
    if (next !== sharedValue) {
      publish(next)
    }
  }

  async function loadSharedValue() {
    const currentClientId = clientId()
    if (isDesktop) {
      await listen<unknown>(SETTING_CHANGED_EVENT, receiveChange).catch((error) => {
        toast.error(syncErrorMessage, { description: String(error) })
      })
    }
    let value: Value = (await load(currentClientId, (error) => {
      toast.error(saveErrorMessage, { description: String(error) })
    })) as Value
    for (const [key, setting] of pendingChanges) {
      value = apply(value, currentClientId, key, setting)
    }
    pendingChanges.clear()
    publish(value)
    return value
  }

  function fetchValue() {
    sharedValuePromise ??= loadSharedValue()
    return sharedValuePromise
  }

  function save(changesToSave: Setting[]) {
    for (const [key, value] of changesToSave) {
      inFlightWrites.set(key, (inFlightWrites.get(key) ?? 0) + 1)
      sharedWrite = sharedWrite
        .then(() => saveSetting(key, value))
        .catch((error) => {
          toast.error(saveErrorMessage, { description: String(error) })
        })
        .finally(() => {
          finishWrite(key)
        })
    }
  }

  function useSettings() {
    const value = useSyncExternalStore(subscribe, snapshot, snapshot)
    useEffect(() => {
      void fetchValue()
    }, [])
    const updateValue = useCallback((change: Change) => {
      if (!sharedValue) {
        return
      }
      const next = update(sharedValue, change)
      publish(next)
      save(changes(change, clientId()))
    }, [])
    return [value, updateValue] as const
  }

  return { useSettings }
}
