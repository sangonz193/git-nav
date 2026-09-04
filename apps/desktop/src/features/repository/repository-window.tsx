import {
  DockviewDefaultTab,
  DockviewReact,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelHeaderProps,
  type IWatermarkPanelProps,
} from "dockview-react"
import { FileDiff, GitGraph, Plus } from "lucide-react"
import { createContext, useContext, type ComponentType } from "react"

import { Button } from "@workspace/shadcn/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/shadcn/components/dropdown-menu"
import { CommitGraphPanel } from "../commit-graph/commit-graph-panel"
import { DiffPanel } from "../diff/diff-panel"
import { panelId } from "../../lib/panel-id"

export type RepositoryPanelParams = {
  name: string
  path: string
}

export type DiffPanelParams = RepositoryPanelParams & {
  baseRef: string
  headRef: string
  mergeBase?: boolean
}

// Matches the sentinel the diff commands accept in place of a commit; not a legal ref name.
export const WORKTREE_REF = ":worktree"

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

function EmptyRepository({ containerApi }: IWatermarkPanelProps) {
  const params = useContext(RepositoryContext)
  if (!params) {
    return null
  }

  return (
    <div className="flex h-full items-center justify-center">
      <Button onClick={() => addGraphPanel(containerApi, params)}>
        <Plus />
        New tab
      </Button>
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
  const name = path.split("/").filter(Boolean).at(-1) ?? path
  const params = { name, path }

  return (
    <main className="h-svh">
      <RepositoryContext.Provider value={params}>
        <DockviewReact
          components={repositoryPanels}
          disableDnd={false}
          disableTabsOverflowList
          dndStrategy="pointer"
          onReady={(event) => {
            event.api.addPanel({
              component: "graph",
              id: "repository-graph",
              params,
              tabComponent: "graph",
              title: "Graph",
            })
          }}
          rightHeaderActionsComponent={NewTabAction}
          tabComponents={repositoryTabs}
          theme={repositoryDockviewTheme}
          watermarkComponent={EmptyRepository}
        />
      </RepositoryContext.Provider>
    </main>
  )
}
