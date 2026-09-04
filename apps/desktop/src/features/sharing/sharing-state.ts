import { listen } from "@tauri-apps/api/event"
import { useEffect, useState } from "react"

import { invoke, isDesktop } from "@/lib/ipc"

export type SharingState = {
  entryUrls: string[]
  host: string | null
  port: number | null
  sharing: boolean
}

export type SharingSettings = {
  host: "0.0.0.0" | "127.0.0.1"
  port: number
  publicUrl: string
  startSharing: boolean
}

export const defaultSharingSettings: SharingSettings = {
  host: "127.0.0.1",
  port: 4300,
  publicUrl: "",
  startSharing: false,
}

export function sharingPort(value: unknown) {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1024 &&
    value <= 65535
    ? value
    : null
}

export function sharingSettings(
  settings: Record<string, unknown>
): SharingSettings {
  const host = settings["serve.host"]
  const storedPort = settings["serve.port"]
  const port = sharingPort(storedPort)
  if (storedPort !== undefined && port === null) {
    throw new Error("The saved port must be a number between 1024 and 65535.")
  }
  return {
    host: host === "0.0.0.0" ? host : "127.0.0.1",
    port: port ?? defaultSharingSettings.port,
    publicUrl:
      typeof settings["serve.publicUrl"] === "string"
        ? settings["serve.publicUrl"]
        : "",
    startSharing: settings["serve.startSharing"] === true,
  }
}

function reachableFrom(host: string | null): SharingSettings["host"] | null {
  if (host === null) return null
  // Any address the server bound to other than a loopback one is reachable from the network.
  return host === "::1" || host.startsWith("127.") ? "127.0.0.1" : "0.0.0.0"
}

export function displayedSharingSettings(
  settings: SharingSettings,
  state: SharingState | null
): SharingSettings {
  if (state?.sharing !== true) return settings
  return {
    ...settings,
    host: reachableFrom(state.host) ?? settings.host,
    port: state.port ?? settings.port,
  }
}

export function sharingPublicUrl(value: string) {
  if (value === "") return ""
  try {
    const url = new URL(value)
    const isHttp = url.protocol === "http:" || url.protocol === "https:"
    return isHttp && url.hostname !== "" ? value : null
  } catch {
    return null
  }
}

export function useSharingState() {
  const [state, setState] = useState<SharingState | null>(null)

  useEffect(() => {
    if (!isDesktop) return

    let disposed = false
    let receivedChange = false
    let unlisten: (() => void) | undefined

    void listen<SharingState>("sharing-changed", ({ payload }) => {
      receivedChange = true
      if (!disposed) setState(payload)
    })
      .then(async (dispose) => {
        if (disposed) {
          dispose()
          return
        }
        unlisten = dispose
        const initial = await invoke<SharingState>("sharing_state")
        if (!disposed && !receivedChange) setState(initial)
      })
      .catch(() => {
        if (!disposed) setState(null)
      })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  return state
}
