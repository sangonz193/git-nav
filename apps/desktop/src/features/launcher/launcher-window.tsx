import { open } from "@tauri-apps/plugin-dialog"
import { invoke } from "@tauri-apps/api/core"
import { FolderGit2, FolderOpen, GitBranch, Plus } from "lucide-react"
import { useEffect, useState } from "react"

import { Button } from "@workspace/shadcn/components/button"

export type Repository = {
  path: string
  name: string
  branch: string
  remote: string | null
}

export function LauncherWindow() {
  const [repositories, setRepositories] = useState<Repository[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isChoosing, setIsChoosing] = useState(false)

  useEffect(() => {
    invoke<Repository[]>("recent_repositories")
      .then(setRepositories)
      .catch((message: unknown) => setError(String(message)))
  }, [])

  async function chooseRepository() {
    setIsChoosing(true)
    setError(null)

    try {
      const selectedPath = await open({
        directory: true,
        multiple: false,
        title: "Choose a Git repository",
      })

      if (selectedPath) {
        await invoke("open_repository", { path: selectedPath })
      }
    } catch (message) {
      setError(String(message))
    } finally {
      setIsChoosing(false)
    }
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-8">
      <section className="w-full max-w-lg space-y-7">
        <div className="space-y-2">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <GitBranch className="size-5" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Open a repository</h1>
          <p className="text-sm text-muted-foreground">Choose a recent repository or browse for another folder.</p>
        </div>

        {repositories.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Recent</p>
            <div className="overflow-hidden rounded-xl border bg-card">
              {repositories.map((repository) => (
                <button
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted"
                  key={repository.path}
                  onClick={() => invoke("open_repository", { path: repository.path }).catch((message: unknown) => setError(String(message)))}
                >
                  <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{repository.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{repository.path}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">{repository.branch}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <Button className="w-full" disabled={isChoosing} onClick={chooseRepository} size="lg">
          {isChoosing ? <FolderOpen /> : <Plus />}
          {isChoosing ? "Opening folder picker…" : "Choose folder"}
        </Button>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </section>
    </main>
  )
}
