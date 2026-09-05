import { getVersion } from "@tauri-apps/api/app"
import { invoke } from "@tauri-apps/api/core"
import { relaunch } from "@tauri-apps/plugin-process"
import { check, type Update } from "@tauri-apps/plugin-updater"
import { useEffect, useState, useSyncExternalStore } from "react"
import { toast } from "@workspace/shadcn/components/sonner"
import { compareVersions } from "./version-comparison"

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const LAST_CHECK_KEY = "git-nav-update-check"
const AVAILABLE_KEY = "git-nav-update-available"

function readStored(key: string) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // A webview that refuses storage still updates, it just asks again next launch.
  }
}

// A toast is gone in seconds and only reaches the window it opened in, so the version that was
// found outlives it here and every menu reads it.
let availableVersion = readStored(AVAILABLE_KEY)
const listeners = new Set<() => void>()

function setAvailableVersion(version: string | null) {
  if (availableVersion === version) return
  availableVersion = version
  writeStored(AVAILABLE_KEY, version)
  for (const listener of listeners) listener()
}

export function useAvailableUpdate() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => availableVersion,
    () => null
  )
}

export function useAppVersion() {
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    void getVersion()
      .then(setVersion)
      .catch(() => setVersion(null))
  }, [])
  return version
}

async function installUpdate(update: Update) {
  try {
    toast("Downloading update")
    await update.downloadAndInstall()
    setAvailableVersion(null)
    toast("Update installed", {
      action: {
        label: "Restart now",
        onClick: () => void relaunch().catch(() => undefined),
      },
      description: "Restart Git Nav to finish updating.",
      duration: Infinity,
    })
  } catch (error) {
    toast("Could not install update", { description: String(error) })
  } finally {
    await update.close().catch(() => undefined)
  }
}

function offerUpdate(update: Update) {
  let claimed = false
  const release = () => {
    if (claimed) return
    claimed = true
    void update.close().catch(() => undefined)
  }

  toast("Update available", {
    action: {
      label: "Install update",
      onClick: () => {
        if (claimed) return
        claimed = true
        void installUpdate(update)
      },
    },
    description: `Git Nav ${update.version} is ready to install.`,
    // The menu keeps the offer, but dismissing a toast should not be how an update is lost.
    duration: Infinity,
    onDismiss: release,
  })
}

async function updateCommandToast(command: string) {
  const [currentVersion, response] = await Promise.all([
    getVersion(),
    fetch("https://registry.npmjs.org/git-nav/latest"),
  ])
  if (!response.ok) return false

  const latestVersion = ((await response.json()) as { version?: unknown })
    .version
  if (typeof latestVersion !== "string") return false
  if (compareVersions(currentVersion, latestVersion) >= 0) {
    setAvailableVersion(null)
    return true
  }

  setAvailableVersion(latestVersion)
  toast("Update available", {
    action: {
      label: "Copy command",
      onClick: () => void navigator.clipboard.writeText(command),
    },
    description: (
      <span>
        Run <code>{command}</code> to update Git Nav.
      </span>
    ),
    duration: Infinity,
  })
  return true
}

/** Runs the check the menu asks for, which answers even when there is nothing to install. */
export async function checkForUpdateNow() {
  try {
    const command = await invoke<string | null>("update_command")
    if (command) {
      const answered = await updateCommandToast(command)
      writeStored(LAST_CHECK_KEY, String(Date.now()))
      if (!answered) toast("Could not check for updates")
      else if (!availableVersion) toast("Git Nav is up to date")
      return
    }

    const update = await check()
    writeStored(LAST_CHECK_KEY, String(Date.now()))
    if (!update) {
      setAvailableVersion(null)
      toast("Git Nav is up to date")
      return
    }

    setAvailableVersion(update.version)
    offerUpdate(update)
  } catch (error) {
    toast("Could not check for updates", { description: String(error) })
  }
}

/** Installs whatever a check finds, for the menu entry that already knows one is waiting. */
export async function installAvailableUpdate() {
  try {
    const command = await invoke<string | null>("update_command")
    if (command) {
      await updateCommandToast(command)
      return
    }

    const update = await check()
    if (!update) {
      setAvailableVersion(null)
      toast("Git Nav is up to date")
      return
    }
    await installUpdate(update)
  } catch (error) {
    toast("Could not install update", { description: String(error) })
  }
}

export async function checkForUpdate() {
  if (import.meta.env.DEV) return

  const lastCheck = Number(readStored(LAST_CHECK_KEY)) || undefined
  if (lastCheck && Date.now() - lastCheck < CHECK_INTERVAL_MS) return

  try {
    const command = await invoke<string | null>("update_command")
    if (command) {
      const answered = await updateCommandToast(command)
      // Only a conclusive answer opens the interval, so a check that could not reach the registry
      // runs again on the next launch instead of going quiet for hours.
      if (answered) writeStored(LAST_CHECK_KEY, String(Date.now()))
      return
    }

    const update = await check()
    writeStored(LAST_CHECK_KEY, String(Date.now()))
    if (!update) {
      setAvailableVersion(null)
      return
    }

    setAvailableVersion(update.version)
    offerUpdate(update)
  } catch {
    // The menu still offers a check that reports why.
  }
}
