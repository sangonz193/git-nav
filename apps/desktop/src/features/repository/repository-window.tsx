import {
  DockviewDefaultTab,
  DockviewReact,
  type DockviewApi,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelHeaderProps,
  type IWatermarkPanelProps,
} from "dockview-react"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { FileDiff, GitGraph, Plus } from "lucide-react"
import { createContext, useContext, useEffect, useRef, useState, type ComponentType } from "react"

import { Button } from "@workspace/shadcn/components/button"
import { toast } from "@workspace/shadcn/components/sonner"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/shadcn/components/dropdown-menu"
import { AppMenuButton } from "../app-menu/app-menu"
import { CommitGraphPanel } from "../commit-graph/commit-graph-panel"
import { DiffPanel } from "../diff/diff-panel"
import { panelId } from "../../lib/panel-id"
import { invoke, isDesktop } from "../../lib/ipc"
import { closeRepositoryWindowAfterSaving, listenForRepositoryLayoutPageHide, repositoryLayoutRestoreController, repositoryLayoutSaveScheduler, REPOSITORY_LAYOUT_VERSION, restoreRepositoryLayout, unresolvablePanelIds, usableRepositoryLayout } from "../../lib/repository-layout"
import { settingsClientId } from "../../lib/settings"

export type RepositoryPanelParams = {
  name: string
  path: string
}

export type DiffPanelUserPreferences = {
  fileTreeOpen?: boolean
  mode?: "split" | "unified"
}

export type DiffPanelParams = RepositoryPanelParams & {
  baseRef: string
  baseLabel?: string
  headRef: string
  headLabel?: string
  mergeBase?: boolean
  selectedFilePath?: string | null
  userPreferences?: DiffPanelUserPreferences
}

export type GraphPanelUserPreferences = {
  columnWidths?: Record<string, number>
}

export type GraphPanelParams = RepositoryPanelParams & {
  selectedCommitHashes?: string[]
  userPreferences?: GraphPanelUserPreferences
}

// The icon names the panel, not what it is pointed at, which the selectors and the title already say.
// It leaves the title free to be only the thing itself: a comparison, a worktree or a stash.
function panelTab(Icon: ComponentType<{ className?: string }>) {
  return function PanelTab(props: IDockviewPanelHeaderProps) {
    return (
      <div className="flex h-full w-full min-w-0 items-center gap-1.5">
        <Icon className="pointer-events-none size-3.5 shrink-0" />
        <DockviewDefaultTab {...props} />
      </div>
    )
  }
}

const repositoryTabs = {
  diff: panelTab(FileDiff),
  graph: panelTab(GitGraph),
}

const RepositoryContext = createContext<RepositoryPanelParams | null>(null)

function addGraphPanel(containerApi: IWatermarkPanelProps["containerApi"] | IDockviewHeaderActionsProps["containerApi"], params: RepositoryPanelParams, referencePanel?: IDockviewHeaderActionsProps["activePanel"]) {
  containerApi.addPanel({
    component: "graph",
    id: panelId("graph"),
    params,
    ...(referencePanel ? { position: { direction: "within" as const, referencePanel } } : {}),
    tabComponent: "graph",
    title: "Graph",
  })
}

function addDiffPanel(containerApi: IDockviewHeaderActionsProps["containerApi"], params: RepositoryPanelParams, referencePanel: IDockviewHeaderActionsProps["activePanel"]) {
  containerApi.addPanel({
    component: "diff",
    id: panelId("diff"),
    params: { ...params, baseRef: "HEAD~1", headRef: "HEAD" },
    position: { direction: "within", referencePanel },
    tabComponent: "diff",
    title: "HEAD~1..HEAD",
  })
}

function NewTabAction({ activePanel, containerApi }: IDockviewHeaderActionsProps) {
  const params = useContext(RepositoryContext)
  if (!params) {
    return null
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="New tab"
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground"
      >
        <Plus className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={() => addGraphPanel(containerApi, params, activePanel)}>
          <GitGraph />
          Graph
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => addDiffPanel(containerApi, params, activePanel)}>
          <FileDiff />
          Diff
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function RepositoryHeaderActions(props: IDockviewHeaderActionsProps) {
  const showAppMenu = props.isGroupActive && (!props.location || props.location.type === "grid")
  return (
    <div className="flex items-center gap-0.5">
      <NewTabAction {...props} />
      {showAppMenu && <AppMenuButton />}
    </div>
  )
}

function EmptyRepository({ containerApi }: IWatermarkPanelProps) {
  const params = useContext(RepositoryContext)
  if (!params) {
    return null
  }

  return (
    <div className="flex h-full items-center justify-center gap-1">
      <Button onClick={() => addGraphPanel(containerApi, params)}>
        <Plus />
        New tab
      </Button>
      <AppMenuButton />
    </div>
  )
}

const repositoryPanels = {
  diff: DiffPanel,
  graph: CommitGraphPanel,
}

const repositoryDockviewTheme = {
  name: "git-nav",
  className: "git-nav-dockview-theme",
  dndOverlayBorder: "2px solid #3b82f6",
  dndOverlayMounting: "absolute" as const,
  dndPanelOverlay: "group" as const,
  tabGroupIndicator: "none" as const,
}

export function RepositoryWindow({ path }: { path: string }) {
  const [repositoryPath, setRepositoryPath] = useState(path)
  const activeDockview = useRef<DockviewApi | null>(null)
  const disposeDockviewListeners = useRef<() => void>(() => undefined)
  const name = repositoryPath.split("/").filter(Boolean).at(-1) ?? repositoryPath
  const params = { name, path: repositoryPath }

  useEffect(() => () => {
    disposeDockviewListeners.current()
    activeDockview.current = null
  }, [])

  return (
    <main className="h-svh">
      <RepositoryContext.Provider value={params}>
        <DockviewReact
          components={repositoryPanels}
          disableDnd={false}
          disableTabsOverflowList
          dndStrategy="pointer"
          onReady={(event) => {
            disposeDockviewListeners.current()
            activeDockview.current = event.api
            const clientId = settingsClientId(isDesktop, localStorage)
            let repositoryParams = params
            const isCurrent = () => activeDockview.current === event.api
            const layoutSave = repositoryLayoutSaveScheduler(
              (keepalive) => invoke<void>("save_repository_layout", {
                clientId,
                layout: { version: REPOSITORY_LAYOUT_VERSION, layout: event.api.toJSON() },
                path: repositoryParams.path,
              }, { keepalive }),
              (error) => {
                toast.error("Could not save repository layout", { description: String(error) })
              },
              isCurrent,
            )
            const layoutRestore = repositoryLayoutRestoreController(() => {
              if (isCurrent()) {
                layoutSave.schedule()
              }
            })
            const save = () => {
              if (isCurrent()) {
                layoutRestore.changed()
              }
            }
            const layoutSubscription = event.api.onDidLayoutChange(save)
            const panelAddedSubscription = event.api.onDidAddPanel(() => layoutRestore.userAction())
            let closeUnlisten: (() => void) | undefined
            let pageHideUnlisten: (() => void) | undefined
            let listenersDisposed = false
            if (isDesktop) {
              const repositoryWindow = getCurrentWindow()
              void repositoryWindow.onCloseRequested((event) => closeRepositoryWindowAfterSaving(event, layoutSave.flush, () => repositoryWindow.destroy())).then((unlisten) => {
                if (listenersDisposed) {
                  unlisten()
                } else {
                  closeUnlisten = unlisten
                }
              })
            } else {
              pageHideUnlisten = listenForRepositoryLayoutPageHide(window, layoutSave.flushOnPageHide)
            }
            disposeDockviewListeners.current = () => {
              listenersDisposed = true
              closeUnlisten?.()
              pageHideUnlisten?.()
              layoutSubscription.dispose()
              panelAddedSubscription.dispose()
              layoutSave.dispose()
            }
            const addFallbackPanel = () => {
              event.api.addPanel({ component: "graph", id: "repository-graph", params: repositoryParams, tabComponent: "graph", title: "Graph" })
            }
            void (async () => {
              try {
                const stored = await invoke<{ path: string, layout: unknown }>("repository_layout", { clientId, path: repositoryParams.path })
                if (!isCurrent() || !layoutRestore.pending) {
                  return
                }
                repositoryParams = { name: stored.path.split("/").filter(Boolean).at(-1) ?? stored.path, path: stored.path }
                setRepositoryPath(stored.path)
                const layout = usableRepositoryLayout(stored.layout, stored.path)
                if (layout) {
                  const invalidPanelIds = await unresolvablePanelIds(layout, (panelPath, revision) => invoke("resolve_revision", { repoPath: panelPath, revision }))
                  if (!isCurrent()) {
                    return
                  }
                  layoutRestore.restored(() => {
                    if (!restoreRepositoryLayout(event.api, layout, invalidPanelIds)) {
                      addFallbackPanel()
                    }
                  })
                  return
                }
                layoutRestore.restored(addFallbackPanel)
              } catch (error) {
                if (!isCurrent() || !layoutRestore.failed(addFallbackPanel)) {
                  return
                }
                toast.error("Could not load repository layout", { description: String(error) })
              }
            })()
          }}
          rightHeaderActionsComponent={RepositoryHeaderActions}
          tabComponents={repositoryTabs}
          theme={repositoryDockviewTheme}
          watermarkComponent={EmptyRepository}
        />
      </RepositoryContext.Provider>
    </main>
  )
}
