import {
  DockviewReact,
  type DockviewApi,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelHeaderProps,
  type IWatermarkPanelProps,
} from "dockview-react"
import { FileDiff, FilePen, GitGraph, Plus, RotateCcw, X } from "lucide-react"
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from "react"

import { Button } from "@workspace/shadcn/components/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@workspace/shadcn/components/context-menu"
import { toast } from "@workspace/shadcn/components/sonner"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/shadcn/components/dropdown-menu"
import { usesNativeMenu } from "../app-menu/app-menu-shortcuts"
import { ShowSidebarControls } from "../workspace/sidebar-toggle"
import { CommitGraphPanel } from "../commit-graph/commit-graph-panel"
import { DiffPanel } from "../diff/diff-panel"
import { WorkingTreePanel } from "../working-tree/working-tree-panel"
import { closedTabHistory, reopenedPanel } from "../../lib/closed-tabs"
import { dependsOnWorktree } from "../diff/diff-title"
import { panelId } from "../../lib/panel-id"
import { tabsToClose, type TabCloseScope } from "../../lib/tab-closing"
import { useTabShortcuts } from "../../lib/tab-shortcuts"
import { invoke, isDesktop } from "../../lib/ipc"
import {
  listenForRepositoryLayoutPageHide,
  repositoryLayoutRestoreController,
  repositoryLayoutSaveScheduler,
  REPOSITORY_LAYOUT_VERSION,
  restoreRepositoryLayout,
  unresolvablePanelIds,
  usableRepositoryLayout,
} from "../../lib/repository-layout"
import {
  repositoryLayoutDrafts,
  RepositoryLayoutDraftsContext,
} from "../../lib/repository-layout-drafts"
import { settingsClientId } from "../../lib/settings"
import {
  newTabParams,
  type DiffPanelParams,
  type RepositoryPanelParams,
} from "../../lib/panel-params"
import { worktreeName } from "../working-tree/working-tree-state"
import type { Project } from "./project"
import { worktreeGraphPanelId } from "./worktree-graph-tab"
import type { OpenedRepository } from "../workspace/workspace"

// The icon names the panel, not what it is pointed at, which the selectors and the title already say.
// It leaves the title free to be only the thing itself: a comparison, a worktree or a stash.
function panelTab(
  Icon: ComponentType<{ className?: string }>,
  Hint?: ComponentType<IDockviewPanelHeaderProps>,
) {
  return function PanelTab(props: IDockviewPanelHeaderProps) {
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex h-full w-full min-w-0 items-center gap-1.5">
            <Icon className="pointer-events-none size-3.5 shrink-0" />
            <PanelTabLabel api={props.api} hint={Hint && <Hint {...props} />} />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <TabMenuItems api={props.api} />
        </ContextMenuContent>
      </ContextMenu>
    )
  }
}

function usePanelTitle(api: IDockviewPanelHeaderProps["api"]) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const disposable = api.onDidTitleChange(onChange)
      return () => disposable.dispose()
    },
    [api],
  )
  return useSyncExternalStore(subscribe, () => api.title)
}

// Dockview's default tab, with room between the title and the close action that it does not leave.
function PanelTabLabel({
  api,
  hint,
}: {
  api: IDockviewPanelHeaderProps["api"]
  hint: ReactNode
}) {
  const title = usePanelTitle(api)
  const middlePressed = useRef(false)
  return (
    <div
      className="dv-default-tab"
      onPointerDown={(event) => {
        middlePressed.current = event.button === 1
      }}
      onPointerLeave={() => {
        middlePressed.current = false
      }}
      onPointerUp={(event) => {
        if (middlePressed.current && event.button === 1) {
          event.preventDefault()
          api.close()
        }
        middlePressed.current = false
      }}
    >
      <span className="dv-default-tab-content">{title}</span>
      {hint}
      <button
        aria-label="Close tab"
        className="dv-default-tab-action"
        onClick={(event) => {
          event.preventDefault()
          api.close()
        }}
        onPointerDown={(event) => event.preventDefault()}
        type="button"
      >
        <svg
          aria-hidden
          className="dv-svg"
          height="11"
          viewBox="0 0 28 28"
          width="11"
        >
          <path d="M2.1 27.3L0 25.2L11.55 13.65L0 2.1L2.1 0L13.65 11.55L25.2 0L27.3 2.1L15.75 13.65L27.3 25.2L25.2 27.3L13.65 15.75L2.1 27.3Z" />
        </svg>
      </button>
    </div>
  )
}

// The menu reads the group when it opens: siblings come and go without this tab rendering again.
function TabMenuItems({ api }: { api: IDockviewPanelHeaderProps["api"] }) {
  const panels = api.group.panels
  const closeScope = (scope: TabCloseScope) => {
    for (const panel of tabsToClose(panels, api.id, scope)) {
      panel.api.close()
    }
  }
  const disabled = (scope: TabCloseScope) =>
    tabsToClose(panels, api.id, scope).length === 0
  return (
    <>
      <ContextMenuItem onSelect={() => api.close()}>
        <X />
        Close
      </ContextMenuItem>
      <ContextMenuItem
        disabled={disabled("others")}
        onSelect={() => closeScope("others")}
      >
        Close Others
      </ContextMenuItem>
      <ContextMenuItem
        disabled={disabled("left")}
        onSelect={() => closeScope("left")}
      >
        Close Tabs to the Left
      </ContextMenuItem>
      <ContextMenuItem
        disabled={disabled("right")}
        onSelect={() => closeScope("right")}
      >
        Close Tabs to the Right
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => closeScope("all")}>
        Close All
      </ContextMenuItem>
    </>
  )
}

function useProjectHomePath(path: string) {
  const [homePath, setHomePath] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    invoke<Project>("project_snapshot", { path })
      .then((project) => {
        if (!cancelled) {
          setHomePath(project.path)
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [path])
  return homePath
}

function WorktreeHint({ path }: { path: string }) {
  return (
    <span className="shrink-0 text-muted-foreground">{worktreeName(path)}</span>
  )
}

function DiffTabHint({ params }: IDockviewPanelHeaderProps) {
  const { baseRef, headRef, path } = params as DiffPanelParams
  return dependsOnWorktree({ base: baseRef, head: headRef }) ?
      <WorktreeHint path={path} />
    : null
}

function GraphTabHint({ params }: IDockviewPanelHeaderProps) {
  const { path } = params as RepositoryPanelParams
  const homePath = useProjectHomePath(path)
  return homePath !== null && homePath !== path ?
      <WorktreeHint path={path} />
    : null
}

const repositoryTabs = {
  diff: panelTab(FileDiff, DiffTabHint),
  graph: panelTab(GitGraph, GraphTabHint),
  "working-tree": panelTab(FilePen),
}

const RepositoryContext = createContext<RepositoryPanelParams | null>(null)
// The header and the watermark are rendered by dockview, so the actions they offer reach them the same
// way their parameters do.
const ReopenTabContext = createContext<(() => void) | undefined>(undefined)
const LayoutRestorePendingContext = createContext(true)

function addGraphPanel(
  containerApi:
    | IWatermarkPanelProps["containerApi"]
    | IDockviewHeaderActionsProps["containerApi"],
  params: RepositoryPanelParams,
  referencePanel?: IDockviewHeaderActionsProps["activePanel"],
) {
  containerApi.addPanel({
    component: "graph",
    id: panelId("graph"),
    params,
    ...(referencePanel ?
      { position: { direction: "within" as const, referencePanel } }
    : {}),
    tabComponent: "graph",
    title: "Graph",
  })
}

function addDiffPanel(
  containerApi: IDockviewHeaderActionsProps["containerApi"],
  params: RepositoryPanelParams,
  referencePanel: IDockviewHeaderActionsProps["activePanel"],
) {
  containerApi.addPanel({
    component: "diff",
    id: panelId("diff"),
    params: { ...params, baseRef: "HEAD~1", headRef: "HEAD" },
    position: { direction: "within", referencePanel },
    tabComponent: "diff",
    title: "HEAD~1..HEAD",
  })
}

function addWorkingTreePanel(
  containerApi: IDockviewHeaderActionsProps["containerApi"],
  params: RepositoryPanelParams,
  referencePanel: IDockviewHeaderActionsProps["activePanel"],
) {
  containerApi.addPanel({
    component: "working-tree",
    id: panelId("working-tree"),
    params,
    position: { direction: "within", referencePanel },
    tabComponent: "working-tree",
    title: worktreeName(params.path),
  })
}

function reopenTabShortcut() {
  return isDesktop && usesNativeMenu(navigator.userAgent) ? "⇧⌘T" : (
      "Ctrl+Shift+T"
    )
}

function NewTabAction({
  activePanel,
  containerApi,
}: IDockviewHeaderActionsProps) {
  const repository = useContext(RepositoryContext)
  const reopenTab = useContext(ReopenTabContext)
  if (!repository) {
    return null
  }
  // A tab can move to another worktree without this header rendering again.
  const params = () =>
    newTabParams(
      repository,
      activePanel?.params as
        DiffPanelParams | RepositoryPanelParams | undefined,
    )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="New tab"
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground"
      >
        <Plus className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem
          onSelect={() => addGraphPanel(containerApi, params(), activePanel)}
        >
          <GitGraph />
          Graph
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => addDiffPanel(containerApi, params(), activePanel)}
        >
          <FileDiff />
          Diff
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            addWorkingTreePanel(containerApi, params(), activePanel)
          }
        >
          <FilePen />
          Working tree
        </DropdownMenuItem>
        {reopenTab && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={reopenTab}>
              <RotateCcw />
              Reopen Closed Tab
              {isDesktop && (
                <span className="ml-auto pl-6 text-xs tracking-widest text-muted-foreground">
                  {reopenTabShortcut()}
                </span>
              )}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function topLeftGroupId(
  containerApi: IDockviewHeaderActionsProps["containerApi"],
) {
  const corner = containerApi.groups
    .filter((group) => group.api.location.type === "grid")
    .map((group) => ({ group, rect: group.element.getBoundingClientRect() }))
    .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)[0]
  return corner?.group.id
}

function RepositoryPrefixHeaderActions({
  containerApi,
  group,
}: IDockviewHeaderActionsProps) {
  const [inCorner, setInCorner] = useState(false)
  useLayoutEffect(() => {
    const update = () => setInCorner(topLeftGroupId(containerApi) === group.id)
    update()
    const subscription = containerApi.onDidLayoutChange(update)
    return () => subscription.dispose()
  }, [containerApi, group])
  return inCorner ? <ShowSidebarControls className="mr-1" /> : null
}

function RepositoryHeaderActions(props: IDockviewHeaderActionsProps) {
  return (
    <div className="flex items-center gap-0.5">
      <NewTabAction {...props} />
    </div>
  )
}

function EmptyRepository({ containerApi }: IWatermarkPanelProps) {
  const params = useContext(RepositoryContext)
  const reopenTab = useContext(ReopenTabContext)
  const restorePending = useContext(LayoutRestorePendingContext)
  if (!params || restorePending) {
    return null
  }

  return (
    <div className="empty-repository relative h-full">
      <div className="absolute top-1 left-2">
        <ShowSidebarControls />
      </div>
      <div className="flex h-full items-center justify-center gap-1">
        <Button onClick={() => addGraphPanel(containerApi, params)}>
          <Plus />
          New tab
        </Button>
        {reopenTab && (
          <Button onClick={reopenTab} variant="ghost">
            <RotateCcw />
            Reopen closed tab
          </Button>
        )}
      </div>
    </div>
  )
}

const repositoryPanels = {
  diff: DiffPanel,
  graph: CommitGraphPanel,
  "working-tree": WorkingTreePanel,
}

const repositoryDockviewTheme = {
  name: "git-nav",
  className: "git-nav-dockview-theme",
  dndOverlayBorder: "2px solid #3b82f6",
  dndOverlayMounting: "absolute" as const,
  dndPanelOverlay: "group" as const,
  tabGroupIndicator: "none" as const,
}

function repositoryParamsAt(path: string) {
  return {
    name: path.split("/").filter(Boolean).at(-1) ?? path,
    path,
  }
}

export const RepositoryView = memo(function RepositoryView({
  openedRepository,
  project,
  onCloseRepository,
  onOpenedRepositoryShown,
  registerLayoutFlush,
}: {
  openedRepository: OpenedRepository | null
  project: string
  onCloseRepository: () => void
  onOpenedRepositoryShown: () => void
  registerLayoutFlush: (flush: () => Promise<void>) => () => void
}) {
  const [repositoryPath, setRepositoryPath] = useState<string | null>(null)
  const [layoutDrafts] = useState(repositoryLayoutDrafts)
  const activeDockview = useRef<DockviewApi | null>(null)
  const container = useRef<HTMLElement | null>(null)
  const disposeDockviewListeners = useRef<() => void>(() => undefined)
  const closedTabs = useRef<ReturnType<typeof closedTabHistory> | null>(null)
  const [canReopenTab, setCanReopenTab] = useState(false)
  const [restorePending, setRestorePending] = useState(true)
  const params = useMemo(
    () => (repositoryPath === null ? null : repositoryParamsAt(repositoryPath)),
    [repositoryPath],
  )

  useLayoutEffect(
    () => () => {
      disposeDockviewListeners.current()
      activeDockview.current = null
      closedTabs.current = null
    },
    [],
  )

  useEffect(() => {
    const element = container.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width)
      const height = Math.round(entry.contentRect.height)
      // A container that is not displayed measures zero, which is no size to lay tabs out in.
      if (width > 0 && height > 0) activeDockview.current?.layout(width, height)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const reopenTab = useCallback(() => {
    const api = activeDockview.current
    const history = closedTabs.current
    if (!api || !history) return
    const tab = history.reopenPanel()
    setCanReopenTab(history.size > 0)
    const panel =
      tab && reopenedPanel(tab, (groupId) => Boolean(api.getGroup(groupId)))
    if (panel) api.addPanel(panel)
  }, [])

  // A repository with no tabs left has nothing else the shortcut could mean, so it closes itself.
  useTabShortcuts({
    closeTab: useCallback(() => {
      const panel = activeDockview.current?.activePanel
      if (panel) panel.api.close()
      else onCloseRepository()
    }, [onCloseRepository]),
    reopenTab,
  })

  const openedWorktree =
    openedRepository?.project === project ? openedRepository.worktree : null
  // Waits for the saved layout to settle, so the restore cannot replace the tab this adds.
  useEffect(() => {
    const api = activeDockview.current
    if (!api || !params || restorePending || !openedWorktree) return
    const graphs = api.panels
      .filter((panel) => panel.api.component === "graph")
      .map((panel) => ({
        id: panel.id,
        path: (panel.params as RepositoryPanelParams).path,
      }))
    const panelId = worktreeGraphPanelId(
      graphs,
      openedWorktree,
      api.activePanel?.id,
    )
    if (panelId) {
      api.getPanel(panelId)?.api.setActive()
    } else {
      addGraphPanel(
        api,
        { name: params.name, path: openedWorktree },
        api.activePanel,
      )
    }
    onOpenedRepositoryShown()
  }, [onOpenedRepositoryShown, openedWorktree, params, restorePending])

  return (
    <main className="h-full min-w-0 flex-1" ref={container}>
      <RepositoryContext.Provider value={params}>
        <ReopenTabContext.Provider value={canReopenTab ? reopenTab : undefined}>
          <LayoutRestorePendingContext.Provider value={restorePending}>
            <RepositoryLayoutDraftsContext.Provider value={layoutDrafts}>
              <DockviewReact
                components={repositoryPanels}
                disableAutoResizing
                disableDnd={false}
                disableTabsOverflowList
                dndStrategy="pointer"
                onReady={(event) => {
                  disposeDockviewListeners.current()
                  activeDockview.current = event.api
                  setRestorePending(true)
                  if (container.current) {
                    event.api.layout(
                      container.current.clientWidth,
                      container.current.clientHeight,
                    )
                  }
                  const clientId = settingsClientId(isDesktop, localStorage)
                  let repositoryParams = params
                  const isCurrent = () => activeDockview.current === event.api
                  const layoutSave = repositoryLayoutSaveScheduler(
                    () =>
                      isCurrent() && layoutRestore.canSave ?
                        {
                          project,
                          layout: {
                            version: REPOSITORY_LAYOUT_VERSION,
                            layout: event.api.toJSON(),
                          },
                        }
                      : null,
                    (snapshot, keepalive) =>
                      invoke<void>(
                        "save_project_layout",
                        {
                          clientId,
                          ...snapshot,
                        },
                        { keepalive },
                      ),
                    (error) => {
                      toast.error("Could not save repository layout", {
                        description: String(error),
                      })
                    },
                    layoutDrafts.flush,
                  )
                  const layoutRestore = repositoryLayoutRestoreController(
                    () => {
                      if (isCurrent()) layoutSave.schedule()
                    },
                    () => {
                      if (isCurrent()) setRestorePending(false)
                    },
                  )
                  const save = () => {
                    if (isCurrent()) {
                      layoutRestore.changed()
                    }
                  }
                  const unsubscribeDraftChanges = layoutDrafts.subscribe(save)
                  const layoutSubscription = event.api.onDidLayoutChange(() => {
                    save()
                  })
                  const panelAddedSubscription = event.api.onDidAddPanel(() =>
                    layoutRestore.userAction(),
                  )
                  const history = closedTabHistory()
                  closedTabs.current = history
                  const syncReopenTab = () => setCanReopenTab(history.size > 0)
                  const willMutateSubscription = event.api.onWillMutateLayout(
                    (mutation) => {
                      layoutDrafts.flush()
                      history.beginMutation(mutation.kind, event.api.panels)
                    },
                  )
                  const didMutateSubscription = event.api.onDidMutateLayout(
                    () => {
                      history.endMutation()
                      syncReopenTab()
                    },
                  )
                  const panelRemovedSubscription = event.api.onDidRemovePanel(
                    (panel) => history.closePanel(panel),
                  )
                  const pageHideUnlisten = listenForRepositoryLayoutPageHide(
                    window,
                    layoutSave.flushOnPageHide,
                  )
                  const unregisterLayoutFlush = registerLayoutFlush(
                    layoutSave.flush,
                  )
                  disposeDockviewListeners.current = () => {
                    unregisterLayoutFlush()
                    unsubscribeDraftChanges()
                    pageHideUnlisten()
                    layoutSubscription.dispose()
                    panelAddedSubscription.dispose()
                    willMutateSubscription.dispose()
                    didMutateSubscription.dispose()
                    panelRemovedSubscription.dispose()
                    layoutSave.dispose()
                  }
                  const addFallbackPanel = () => {
                    if (!repositoryParams) return
                    event.api.addPanel({
                      component: "graph",
                      id: "repository-graph",
                      params: repositoryParams,
                      tabComponent: "graph",
                      title: "Graph",
                    })
                  }
                  void (async () => {
                    try {
                      const stored = await invoke<{
                        path: string
                        layout: unknown
                      }>("project_layout", {
                        clientId,
                        project,
                      })
                      if (!isCurrent() || !layoutRestore.pending) {
                        return
                      }
                      repositoryParams = repositoryParamsAt(stored.path)
                      setRepositoryPath(stored.path)
                      const layout = usableRepositoryLayout(stored.layout)
                      if (layout) {
                        const invalidPanelIds = await unresolvablePanelIds(
                          layout,
                          (panelPath, revision) =>
                            invoke("resolve_revision", {
                              repoPath: panelPath,
                              revision,
                            }),
                        )
                        if (!isCurrent()) {
                          return
                        }
                        layoutRestore.restored(() => {
                          if (
                            !restoreRepositoryLayout(
                              event.api,
                              layout,
                              invalidPanelIds,
                            )
                          ) {
                            addFallbackPanel()
                          }
                          // A tab the restore drops points at a revision that is gone, and nobody closed it.
                          history.clear()
                          syncReopenTab()
                        })
                        return
                      }
                      layoutRestore.restored(addFallbackPanel)
                    } catch (error) {
                      if (!isCurrent()) return
                      if (!repositoryParams) {
                        const home = await invoke<Project>("project_by_id", {
                          project,
                        }).catch(() => null)
                        if (!isCurrent()) return
                        if (home) {
                          repositoryParams = repositoryParamsAt(home.path)
                          setRepositoryPath(home.path)
                        }
                      }
                      if (!layoutRestore.failed(addFallbackPanel)) {
                        return
                      }
                      toast.error("Could not load repository layout", {
                        description: String(error),
                      })
                    }
                  })()
                }}
                prefixHeaderActionsComponent={RepositoryPrefixHeaderActions}
                rightHeaderActionsComponent={RepositoryHeaderActions}
                tabComponents={repositoryTabs}
                theme={repositoryDockviewTheme}
                watermarkComponent={EmptyRepository}
              />
            </RepositoryLayoutDraftsContext.Provider>
          </LayoutRestorePendingContext.Provider>
        </ReopenTabContext.Provider>
      </RepositoryContext.Provider>
    </main>
  )
})
