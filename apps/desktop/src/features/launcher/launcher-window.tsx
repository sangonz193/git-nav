import { FolderOpen, Plus } from "lucide-react"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { useCallback, useState } from "react"

import { Button } from "@workspace/shadcn/components/button"
import { useTabShortcuts } from "@/lib/tab-shortcuts"
import { invoke, isDesktop } from "@/lib/ipc"
import { openRepository } from "@/lib/navigation"
import { FolderPicker } from "./folder-picker"
import { ShowSidebarControls } from "../workspace/sidebar-toggle"

export function Launcher({ hasProjects }: { hasProjects: boolean }) {
  const [error, setError] = useState<string | null>(null)
  const [isChoosing, setIsChoosing] = useState(false)
  const [isPickerOpen, setIsPickerOpen] = useState(false)

  useTabShortcuts({
    closeTab: useCallback(() => {
      void getCurrentWindow().close()
    }, []),
  })

  async function chooseRepository() {
    if (!isDesktop) {
      setIsPickerOpen(true)
      return
    }

    setIsChoosing(true)
    setError(null)

    try {
      await invoke<void>("choose_repository")
    } catch (message) {
      setError(String(message))
    } finally {
      setIsChoosing(false)
    }
  }

  return (
    <main className="relative flex h-full items-center justify-center bg-background p-8">
      <div className="absolute top-1 left-2">
        <ShowSidebarControls />
      </div>
      {hasProjects ?
        <p className="text-sm text-muted-foreground">Select a project</p>
      : <section className="flex flex-col items-center gap-4">
          <p className="text-sm text-muted-foreground">
            Open a repository to get started
          </p>
          <Button disabled={isChoosing} onClick={chooseRepository}>
            {isChoosing ?
              <FolderOpen />
            : <Plus />}
            {isChoosing ? "Opening folder picker…" : "Choose folder"}
          </Button>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </section>
      }
      <FolderPicker
        onCancel={() => setIsPickerOpen(false)}
        onChoose={(path) => {
          setIsPickerOpen(false)
          openRepository(path).catch((message: unknown) =>
            setError(String(message)),
          )
        }}
        open={isPickerOpen}
      />
    </main>
  )
}
