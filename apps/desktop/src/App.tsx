import { open } from "@tauri-apps/plugin-dialog"
import { invoke } from "@tauri-apps/api/core"
import {
  DockviewReact,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelProps,
  type IWatermarkPanelProps,
  themeDark,
} from "dockview-react"
import { FolderGit2, FolderOpen, GitBranch, Plus } from "lucide-react"
import { createContext, useContext, useEffect, useState } from "react"

import "dockview-react/dist/styles/dockview.css"
import "./App.css"

import { Button } from "@workspace/shadcn/components/button"

type Repository = {
  path: string
  name: string
  branch: string
  remote: string | null
}

type RepositoryPanelParams = Pick<Repository, "name" | "path">

const RepositoryContext = createContext<RepositoryPanelParams | null>(null)

function RepositoryOverview({ params }: IDockviewPanelProps<RepositoryPanelParams>) {
  return (
    <main className="flex h-full items-center justify-center bg-background p-8">
      <section className="w-full max-w-lg space-y-5 rounded-2xl border bg-card p-7 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-primary p-2 text-primary-foreground">
            <FolderGit2 className="size-5" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold">{params.name}</h1>
            <p className="truncate text-sm text-muted-foreground">{params.path}</p>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">Repository opened and ready to navigate.</p>
      </section>
    </main>
  )
}

function NewTabAction({ activePanel, containerApi }: IDockviewHeaderActionsProps) {
  const params = useContext(RepositoryContext)

  if (!params) {
    return null
  }

  return (
    <button
      aria-label="New tab"
      className="flex size-[34px] items-center justify-center rounded-md border border-zinc-800 bg-zinc-900 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
      onClick={() => {
        if (activePanel) {
          containerApi.addPanel({
            component: "overview",
            id: `repository-overview-${crypto.randomUUID()}`,
            params,
            position: { direction: "within", referencePanel: activePanel },
            title: "Overview",
          })
          return
        }

        containerApi.addPanel({
          component: "overview",
          id: `repository-overview-${crypto.randomUUID()}`,
          params,
          title: "Overview",
        })
      }}
      type="button"
    >
      <Plus className="size-4" />
    </button>
  )
}

function EmptyRepository({ containerApi }: IWatermarkPanelProps) {
  const params = useContext(RepositoryContext)

  if (!params) {
    return null
  }

  return (
    <div className="flex h-full items-center justify-center">
      <Button
        onClick={() => {
          containerApi.addPanel({
            component: "overview",
            id: `repository-overview-${crypto.randomUUID()}`,
            params,
            title: "Overview",
          })
        }}
      >
        <Plus />
        New tab
      </Button>
    </div>
  )
}

const repositoryPanels = {
  overview: RepositoryOverview,
}

const repositoryDockviewTheme = {
  ...themeDark,
  className: "git-nav-dockview-theme",
  tabGroupIndicator: "none" as const,
}

function repositoryPath() {
  return new URLSearchParams(window.location.search).get("repository")
}

export function App() {
  const path = repositoryPath()
  const [repositories, setRepositories] = useState<Repository[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isChoosing, setIsChoosing] = useState(false)

  useEffect(() => {
    if (path) {
      return
    }

    invoke<Repository[]>("recent_repositories")
      .then(setRepositories)
      .catch((message: unknown) => setError(String(message)))
  }, [path])

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

  if (path) {
    const name = path.split("/").filter(Boolean).at(-1) ?? path

    return (
      <main className="h-svh">
        <RepositoryContext.Provider value={{ name, path }}>
          <DockviewReact
            components={repositoryPanels}
            disableTabsOverflowList
            onReady={(event) => {
              event.api.addPanel({
                component: "overview",
                id: "repository-overview",
                params: { name, path },
                title: "Overview",
              })
            }}
            rightHeaderActionsComponent={NewTabAction}
            theme={repositoryDockviewTheme}
            watermarkComponent={EmptyRepository}
          />
        </RepositoryContext.Provider>
      </main>
    )
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
