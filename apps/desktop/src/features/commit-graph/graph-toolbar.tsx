import { Hinted } from "@/components/hinted"
import { SearchMenu } from "@/components/search-menu"
import {
  FoldButtons,
  LabeledRow,
  PanelHeading,
  PanelSection,
  Segmented,
  SwitchRow,
} from "@/components/view-panel"
import { isDesktop } from "@/lib/ipc"
import { Button } from "@workspace/shadcn/components/button"
import { ButtonGroup } from "@workspace/shadcn/components/button-group"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/shadcn/components/dropdown-menu"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/shadcn/components/popover"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/shadcn/components/tooltip"
import { cn } from "@workspace/shadcn/lib/utils"
import {
  Archive,
  Broom,
  ChevronDown,
  LoaderCircle,
  RefreshCw,
  Search,
  SlidersHorizontal,
} from "lucide-react"

import {
  PULL_REQUEST_STATE_LABELS,
  type PullRequestState,
  type StashEntry,
} from "./commit-graph"
import {
  activeFilterCount,
  CHIP_KIND_LABELS,
  CHIP_KINDS,
  DEFAULT_BRANCH_FILTERS,
  PULL_REQUEST_FILTERS,
  PULL_REQUEST_STATES,
  UPSTREAM_FILTERS,
  type BranchFilters,
  type SearchHit,
  type ViewConfig,
  type ViewConfigChange,
} from "./commit-graph-view"
import { OperationMenuItems } from "./commit-operation-menu"
import { CHIP_ICONS } from "./commit-operations"
import {
  dropdownMenuComponents,
  stashMenuEntry,
  type ChipMenuContext,
} from "./row-chips"
import type { useBranchCleanup } from "./use-branch-cleanup"
import { BROWSER_GRAPH_WINDOW_SIZE } from "./use-graph-data"
import type { useGraphSearch } from "./use-graph-search"

export function GraphToolbar({
  cleanup,
  collapseUnmarked,
  config,
  fetch,
  filters,
  graphOffset,
  hasOlderCommits,
  isFetching,
  isGraphWindowLoading,
  menus,
  onActivateSearchHit,
  onCollapseUnmarked,
  pullRequestCount,
  refreshGraph,
  search,
  showGraphWindow,
  stashes,
  updateConfig,
  updateFilters,
}: {
  cleanup: ReturnType<typeof useBranchCleanup>
  collapseUnmarked: boolean
  config: ViewConfig
  fetch: () => void
  filters: BranchFilters
  graphOffset: number
  hasOlderCommits: boolean
  isFetching: boolean
  isGraphWindowLoading: boolean
  menus: ChipMenuContext
  onActivateSearchHit: (hit: SearchHit) => void
  onCollapseUnmarked: (collapse: boolean) => void
  pullRequestCount: number
  refreshGraph: () => void
  search: ReturnType<typeof useGraphSearch>
  showGraphWindow: (offset: number) => void
  stashes: StashEntry[]
  updateConfig: (change: ViewConfigChange) => void
  updateFilters: (change: Partial<BranchFilters>) => void
}) {
  const filterCount = activeFilterCount(filters)
  return (
    <div className="flex items-center justify-between gap-1 border-b px-2 py-1">
      <div className="flex items-center gap-1">
        <Popover
          onOpenChange={(open) =>
            open ? search.open() : search.setIsOpen(false)
          }
          open={search.isOpen}
        >
          <Tooltip>
            <PopoverTrigger asChild>
              <TooltipTrigger asChild>
                <Button
                  aria-label="Search the graph"
                  size="icon-sm"
                  type="button"
                  variant="outline"
                >
                  <Search />
                </Button>
              </TooltipTrigger>
            </PopoverTrigger>
            <TooltipContent>Find a branch, tag or commit</TooltipContent>
          </Tooltip>
          <PopoverContent
            align="start"
            className="w-80"
            onOpenAutoFocus={(event) => event.preventDefault()}
          >
            <SearchMenu
              activeIndex={search.hitIndex}
              inputLabel="Search refs and commits"
              inputRef={search.field}
              items={search.menuItems}
              onClose={() => search.setIsOpen(false)}
              onHighlight={(index) => {
                search.setHitIndex(index)
                onActivateSearchHit(search.hits[index])
              }}
              onQueryChange={search.setInput}
              onSelect={(index, source) => {
                search.setHitIndex(index)
                onActivateSearchHit(search.hits[index])
                if (source === "enter") {
                  search.setIsOpen(false)
                }
              }}
              placeholder="Branch, tag or commit"
              query={search.input}
            />
          </PopoverContent>
        </Popover>
      </div>
      <div className="flex items-center gap-1">
        <FoldButtons
          allCollapsed={collapseUnmarked}
          allExpanded={!collapseUnmarked}
          collapseHint="Collapse commits nothing points at"
          expandHint="Show every commit"
          onCollapse={() => onCollapseUnmarked(true)}
          onExpand={() => onCollapseUnmarked(false)}
        />
        <Popover>
          <Tooltip>
            <PopoverTrigger asChild>
              <TooltipTrigger asChild>
                <Button size="sm" type="button" variant="outline">
                  <SlidersHorizontal />
                  View
                  {filterCount > 0 && (
                    <span className="rounded-full bg-primary px-1.5 text-[0.7rem] leading-4 text-primary-foreground tabular-nums">
                      {filterCount}
                    </span>
                  )}
                </Button>
              </TooltipTrigger>
            </PopoverTrigger>
            <TooltipContent>Choose what the graph shows</TooltipContent>
          </Tooltip>
          <PopoverContent align="end" className="w-72 p-0">
            <ViewPanel
              config={config}
              filters={filters}
              pullRequestCount={pullRequestCount}
              updateConfig={updateConfig}
              updateFilters={updateFilters}
            />
          </PopoverContent>
        </Popover>
        {!isDesktop && graphOffset > 0 && (
          <Hinted hint="Show newer commits">
            <Button
              disabled={isGraphWindowLoading}
              onClick={() =>
                showGraphWindow(
                  Math.max(0, graphOffset - BROWSER_GRAPH_WINDOW_SIZE),
                )
              }
              size="sm"
              type="button"
              variant="outline"
            >
              Newer
            </Button>
          </Hinted>
        )}
        {!isDesktop && hasOlderCommits && (
          <Hinted hint="Show older commits">
            <Button
              disabled={isGraphWindowLoading}
              onClick={() =>
                showGraphWindow(graphOffset + BROWSER_GRAPH_WINDOW_SIZE)
              }
              size="sm"
              type="button"
              variant="outline"
            >
              Older
            </Button>
          </Hinted>
        )}
        <DropdownMenu>
          <Tooltip>
            <DropdownMenuTrigger asChild>
              <TooltipTrigger asChild>
                <Button size="sm" type="button" variant="outline">
                  <Archive />
                  <span className="tabular-nums">
                    {stashes.length > 0 ? stashes.length : "Stash"}
                  </span>
                </Button>
              </TooltipTrigger>
            </DropdownMenuTrigger>
            <TooltipContent>Stashed changes</TooltipContent>
          </Tooltip>
          <DropdownMenuContent>
            <OperationMenuItems
              components={dropdownMenuComponents}
              onSelect={menus.setRequest}
              repository={menus.repository}
              source={null}
              target={{ kind: "worktree" }}
            />
            {stashes.map((entry) =>
              stashMenuEntry(menus, entry, dropdownMenuComponents),
            )}
            {stashes.length === 0 && !menus.repository?.isDirty && (
              <DropdownMenuItem disabled>Nothing is stashed</DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <Hinted
          hint={
            cleanup.candidateCount > 0 ?
              `${cleanup.candidateCount} branch${cleanup.candidateCount === 1 ? "" : "es"} can be cleaned`
            : "Clean merged branches"
          }
        >
          <Button
            aria-label="Clean merged branches"
            disabled={isFetching || cleanup.isPending}
            onClick={() => cleanup.setIsConfirmationOpen(true)}
            size="sm"
            type="button"
            variant="outline"
          >
            {cleanup.isPending ?
              <LoaderCircle className="animate-spin" />
            : <Broom />}
            {cleanup.candidateCount > 0 && (
              <span className="tabular-nums">{cleanup.candidateCount}</span>
            )}
          </Button>
        </Hinted>
        <ButtonGroup>
          <Hinted hint="Refresh graph">
            <Button
              aria-label="Refresh graph"
              disabled={isFetching || cleanup.isPending}
              onClick={() => refreshGraph()}
              size="icon-sm"
              type="button"
              variant="outline"
            >
              {isFetching ?
                <LoaderCircle className="animate-spin" />
              : <RefreshCw />}
            </Button>
          </Hinted>
          <DropdownMenu>
            <Tooltip>
              <DropdownMenuTrigger asChild>
                <TooltipTrigger asChild>
                  <Button
                    aria-label="Fetch options"
                    className="w-6"
                    disabled={isFetching || cleanup.isPending}
                    size="icon-sm"
                    type="button"
                    variant="outline"
                  >
                    <ChevronDown />
                  </Button>
                </TooltipTrigger>
              </DropdownMenuTrigger>
              <TooltipContent>Fetch options</TooltipContent>
            </Tooltip>
            <DropdownMenuContent>
              <DropdownMenuItem disabled={isFetching} onSelect={() => fetch()}>
                <RefreshCw />
                Fetch from origin
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </ButtonGroup>
      </div>
    </div>
  )
}

function ViewPanel({
  config,
  filters,
  pullRequestCount,
  updateConfig,
  updateFilters,
}: {
  config: ViewConfig
  filters: BranchFilters
  pullRequestCount: number
  updateConfig: (change: ViewConfigChange) => void
  updateFilters: (change: Partial<BranchFilters>) => void
}) {
  const hasPullRequests = pullRequestCount > 0
  return (
    <div className="flex flex-col">
      <PanelSection>
        <PanelHeading>Show</PanelHeading>
        {CHIP_KINDS.map((kind) => (
          <SwitchRow
            checked={config.chipKinds[kind]}
            icon={CHIP_ICONS[kind]}
            id={`graph-view-${kind}`}
            key={kind}
            label={CHIP_KIND_LABELS[kind]}
            onCheckedChange={(checked) =>
              updateConfig({ chipKinds: { [kind]: checked } })
            }
          />
        ))}
      </PanelSection>
      <PanelSection>
        <PanelHeading
          action={
            activeFilterCount(filters) > 0 && (
              <Button
                className="h-5 px-1.5 text-xs text-muted-foreground"
                onClick={() => updateFilters(DEFAULT_BRANCH_FILTERS)}
                size="xs"
                type="button"
                variant="ghost"
              >
                Reset
              </Button>
            )
          }
        >
          Branches
        </PanelHeading>
        <LabeledRow label="Upstream">
          <Segmented
            onChange={(upstream) => updateFilters({ upstream })}
            options={UPSTREAM_FILTERS}
            value={filters.upstream}
          />
        </LabeledRow>
        <LabeledRow
          hint={
            hasPullRequests ? null : (
              "No pull requests were found for this repository"
            )
          }
          label="Pull request"
        >
          <Segmented
            disabled={!hasPullRequests}
            onChange={(pullRequest) => updateFilters({ pullRequest })}
            options={PULL_REQUEST_FILTERS}
            value={filters.pullRequest}
          />
        </LabeledRow>
        {filters.pullRequest === "linked" && (
          <div className="flex flex-wrap justify-end gap-1 px-1.5">
            {PULL_REQUEST_STATES.map((state) => (
              <PullRequestStateChip
                checked={filters.pullRequestStates[state]}
                key={state}
                onCheckedChange={(checked) =>
                  updateFilters({
                    pullRequestStates: {
                      ...filters.pullRequestStates,
                      [state]: checked,
                    },
                  })
                }
                state={state}
              />
            ))}
          </div>
        )}
      </PanelSection>
    </div>
  )
}

function PullRequestStateChip({
  checked,
  onCheckedChange,
  state,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  state: PullRequestState
}) {
  return (
    <Button
      aria-pressed={checked}
      className={cn(!checked && "text-muted-foreground")}
      onClick={() => onCheckedChange(!checked)}
      size="xs"
      type="button"
      variant="outline"
    >
      {PULL_REQUEST_STATE_LABELS[state]}
    </Button>
  )
}
