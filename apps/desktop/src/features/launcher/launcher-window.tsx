import { ChevronDown, ChevronRight, FolderGit2, FolderOpen, GitBranch, Plus } from "lucide-react"
import { useEffect, useState } from "react"

import { Button } from "@workspace/shadcn/components/button"
import { invoke, isDesktop } from "@/lib/ipc"
import { openRepository } from "@/lib/navigation"
import { FolderPicker } from "./folder-picker"
import type { Project } from "../repository/project"

export function LauncherWindow() {
  const [projects, setProjects] = useState<Project[]>([])
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [isChoosing, setIsChoosing] = useState(false)
  const [isPickerOpen, setIsPickerOpen] = useState(false)

  useEffect(() => {
    invoke<Project[]>("recent_projects")
      .then(setProjects)
      .catch((message: unknown) => setError(String(message)))
  }, [])

  async function chooseRepository() {
    if (!isDesktop) {
      setIsPickerOpen(true)
      return
    }

    setIsChoosing(true)
    setError(null)

    try {
      const { open } = await import("@tauri-apps/plugin-dialog")
      const selectedPath = await open({
        directory: true,
        multiple: false,
        title: "Choose a Git repository",
      })

      if (typeof selectedPath === "string") {
        await openRepository(selectedPath)
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

        {projects.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Recent</p>
            <div className="overflow-hidden rounded-xl border bg-card">
              {projects.map((project) => {
                const expanded = expandedProjects.has(project.id)
                const mainWorktree = project.worktrees[0]
                return (
                  <div key={project.id}>
                    <div className="flex items-stretch">
                      <button
                        aria-expanded={expanded}
                        aria-label={`${expanded ? "Collapse" : "Expand"} ${project.name} worktrees`}
                        className="flex w-10 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        onClick={() => setExpandedProjects((current) => {
                          const next = new Set(current)
                          if (next.has(project.id)) next.delete(project.id)
                          else next.add(project.id)
                          return next
                        })}
                        type="button"
                      >
                        {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                      </button>
                      <button
                        className="flex min-w-0 flex-1 items-center gap-3 py-3 pr-4 text-left transition-colors hover:bg-muted"
                        onClick={() => openRepository(project.path).catch((message: unknown) => setError(String(message)))}
                        type="button"
                      >
                        <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{project.name}</span>
                          <span className="block truncate text-xs text-muted-foreground">{project.path}</span>
                        </span>
                        <span className="text-xs text-muted-foreground">{mainWorktree?.branch}</span>
                      </button>
                    </div>
                    {expanded && project.worktrees.filter((worktree) => !worktree.isPrunable).map((worktree) => (
                      <button
                        className="flex w-full items-center gap-3 border-t px-4 py-2.5 pl-14 text-left transition-colors hover:bg-muted"
                        key={worktree.path}
                        onClick={() => openRepository(worktree.path).catch((message: unknown) => setError(String(message)))}
                        type="button"
                      >
                        <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm">{worktree.isMain ? "Main worktree" : worktree.name}</span>
                          <span className="block truncate text-xs text-muted-foreground">{worktree.path}</span>
                        </span>
                        <span className="text-xs text-muted-foreground">{worktree.branch}</span>
                      </button>
                    ))}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <Button className="w-full" disabled={isChoosing} onClick={chooseRepository} size="lg">
          {isChoosing ? <FolderOpen /> : <Plus />}
          {isChoosing ? "Opening folder picker…" : "Choose folder"}
        </Button>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </section>
      <FolderPicker
        onCancel={() => setIsPickerOpen(false)}
        onChoose={(path) => {
          setIsPickerOpen(false)
          openRepository(path).catch((message: unknown) => setError(String(message)))
        }}
        open={isPickerOpen}
      />
    </main>
  )
}
