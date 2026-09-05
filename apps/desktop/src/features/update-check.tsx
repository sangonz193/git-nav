import { getVersion } from "@tauri-apps/api/app"
import { invoke } from "@tauri-apps/api/core"
import { check, type Update } from "@tauri-apps/plugin-updater"
import { useEffect } from "react"
import { toast } from "@workspace/shadcn/components/sonner"
import { compareVersions } from "./version-comparison"

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const LAST_CHECK_KEY = "git-nav-update-check"

async function checkForUpdate() {
  if (import.meta.env.DEV) return

  let lastCheck: number | undefined
  try {
    lastCheck = Number(localStorage.getItem(LAST_CHECK_KEY)) || undefined
  } catch {
    return
  }
  if (lastCheck && Date.now() - lastCheck < CHECK_INTERVAL_MS) return

  let command: string | null
  try {
    command = await invoke<string | null>("update_command")
  } catch {
    return
  }
  if (!command) {
    await checkForInstallerUpdate()
    return
  }

  try {
    const [currentVersion, response] = await Promise.all([
      getVersion(),
      fetch("https://registry.npmjs.org/git-nav/latest"),
    ])
    if (!response.ok) return
    const latestVersion = ((await response.json()) as { version?: unknown })
      .version
    if (typeof latestVersion !== "string") return

    // Only a conclusive answer opens the interval, so a check that could not reach the registry runs
    // again on the next launch instead of going quiet for hours.
    localStorage.setItem(LAST_CHECK_KEY, String(Date.now()))

    if (compareVersions(currentVersion, latestVersion) >= 0) return

    toast("Update available", {
      description: (
        <span>
          Run <code>{command}</code> to update Git Nav.
        </span>
      ),
      action: {
        label: "Copy command",
        onClick: () => navigator.clipboard.writeText(command),
      },
    })
  } catch {
    return
  }
}

async function checkForInstallerUpdate() {
  let update: Update | null = null
  try {
    update = await check()
    localStorage.setItem(LAST_CHECK_KEY, String(Date.now()))
    if (!update) return
    const availableUpdate = update

    let updateClaimed = false
    const closeUnclaimedUpdate = () => {
      if (updateClaimed) return
      updateClaimed = true
      void availableUpdate.close().catch(() => undefined)
    }

    toast("Update available", {
      description: `Git Nav ${availableUpdate.version} is ready to install.`,
      action: {
        label: "Install update",
        onClick: () => {
          if (updateClaimed) return
          updateClaimed = true
          void installUpdate(availableUpdate)
        },
      },
      onDismiss: closeUnclaimedUpdate,
      onAutoClose: closeUnclaimedUpdate,
    })
  } catch {
    await update?.close().catch(() => undefined)
  }
}

async function installUpdate(update: Update) {
  try {
    toast("Downloading update")
    await update.downloadAndInstall()
    toast("Update installed", {
      description: "Restart Git Nav to finish updating.",
    })
  } catch {
    toast("Could not install update")
  } finally {
    await update.close().catch(() => undefined)
  }
}

export function UpdateCheck() {
  useEffect(() => {
    void checkForUpdate()
  }, [])

  return null
}
