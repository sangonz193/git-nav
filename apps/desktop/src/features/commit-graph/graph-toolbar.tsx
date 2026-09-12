import { Hinted } from "@/components/hinted"
import { SearchMenu } from "@/components/search-menu"
import { isDesktop } from "@/lib/ipc"
import { Button } from "@workspace/shadcn/components/button"
import { ButtonGroup } from "@workspace/shadcn/components/button-group"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
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
import {
  Archive,
  Broom,
  ChevronDown,
  FoldVertical,
  LoaderCircle,
  RefreshCw,
  Search,
  SlidersHorizontal,
  UnfoldVertical,
} from "lucide-react"

import type { StashEntry } from "./commit-graph"
import {
  CHIP_KIND_LABELS,
  CHIP_KINDS,
  type SearchHit,
  type ViewConfig,
  type ViewConfigChange,
} from "./commit-graph-view"
import { OperationMenuItems } from "./commit-operation-menu"
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
  graphOffset,
  hasOlderCommits,
  isFetching,
  isGraphWindowLoading,
  menus,
  onActivateSearchHit,
  onCollapseUnmarked,
  refreshGraph,
  search,
  showGraphWindow,
  stashes,
  updateConfig,
}: {
  cleanup: ReturnType<typeof useBranchCleanup>
  collapseUnmarked: boolean
  config: ViewConfig
  fetch: () => void
  graphOffset: number
  hasOlderCommits: boolean
  isFetching: boolean
  isGraphWindowLoading: boolean
  menus: ChipMenuContext
  onActivateSearchHit: (hit: SearchHit) => void
  onCollapseUnmarked: (collapse: boolean) => void
  refreshGraph: () => void
  search: ReturnType<typeof useGraphSearch>
  showGraphWindow: (offset: number) => void
  stashes: StashEntry[]
  updateConfig: (change: ViewConfigChange) => void
}) {
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
        <Hinted
          hint={
            collapseUnmarked ? "Show every commit" : (
              "Collapse commits nothing points at"
            )
          }
        >
          <Button
            aria-label="Collapse commits nothing points at"
            aria-pressed={collapseUnmarked}
            className={collapseUnmarked ? "bg-muted" : undefined}
            onClick={() => onCollapseUnmarked(!collapseUnmarked)}
            size="icon-sm"
            type="button"
            variant="outline"
          >
            {collapseUnmarked ?
              <UnfoldVertical />
            : <FoldVertical />}
          </Button>
        </Hinted>
        <DropdownMenu>
          <Tooltip>
            <DropdownMenuTrigger asChild>
              <TooltipTrigger asChild>
                <Button size="sm" type="button" variant="outline">
                  <SlidersHorizontal />
                  View
                </Button>
              </TooltipTrigger>
            </DropdownMenuTrigger>
            <TooltipContent>Choose what the graph shows</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Show</DropdownMenuLabel>
            {CHIP_KINDS.map((kind) => (
              <DropdownMenuCheckboxItem
                checked={config.chipKinds[kind]}
                key={kind}
                onCheckedChange={(checked) =>
                  updateConfig({ chipKinds: { [kind]: checked === true } })
                }
                onSelect={(event) => event.preventDefault()}
              >
                {CHIP_KIND_LABELS[kind]}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
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
