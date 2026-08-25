import {
  DockviewReact,
  type IDockviewHeaderActionsProps,
  type IWatermarkPanelProps,
  themeDark,
} from "dockview-react"
import { GitCompareArrows, GitGraph, Plus } from "lucide-react"
import { createContext, useContext } from "react"

import { Button } from "@workspace/shadcn/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/shadcn/components/dropdown-menu"
import { CommitGraphPanel } from "../commit-graph/commit-graph-panel"
import { DiffPanel } from "../diff/diff-panel"

export type RepositoryPanelParams = {
  name: string
  path: string
}

export type DiffPanelParams = RepositoryPanelParams & {
  baseRef: string
  headRef: string
}

const RepositoryContext = createContext<RepositoryPanelParams | null>(null)

function addGraphPanel(containerApi: IWatermarkPanelProps["containerApi"] | IDockviewHeaderActionsProps["containerApi"], params: RepositoryPanelParams, referencePanel?: IDockviewHeaderActionsProps["activePanel"]) {
  containerApi.addPanel({
    component: "graph",
    id: `repository-graph-${crypto.randomUUID()}`,
    params,
    ...(referencePanel ? { position: { direction: "within" as const, referencePanel } } : {}),
    title: "Graph",
  })
}

function addDiffPanel(containerApi: IDockviewHeaderActionsProps["containerApi"], params: RepositoryPanelParams, referencePanel: IDockviewHeaderActionsProps["activePanel"]) {
  containerApi.addPanel({
    component: "diff",
    id: `repository-diff-${crypto.randomUUID()}`,
    params: { ...params, baseRef: "HEAD~1", headRef: "HEAD" },
    position: { direction: "within", referencePanel },
    title: "Diff",
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
        className="flex size-[34px] items-center justify-center rounded-[9px] text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-100 data-[state=open]:bg-zinc-800 data-[state=open]:text-zinc-100"
      >
        <Plus className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={() => addGraphPanel(containerApi, params, activePanel)}>
          <GitGraph />
          Graph
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => addDiffPanel(containerApi, params, activePanel)}>
          <GitCompareArrows />
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
  ...themeDark,
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
              title: "Graph",
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
