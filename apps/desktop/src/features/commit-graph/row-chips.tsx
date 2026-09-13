import { type WorktreeTarget } from "@/lib/navigation"
import { cn } from "@workspace/shadcn/lib/utils"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@workspace/shadcn/components/context-menu"
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@workspace/shadcn/components/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/shadcn/components/tooltip"
import {
  AppWindow,
  CodeXml,
  Copy,
  ExternalLink,
  FileDiff,
  FilePen,
  FolderOpen,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Terminal,
} from "lucide-react"

import {
  chipLabel,
  pullRequestDescription,
  refName,
  refSelection,
  refSyncLabel,
  splitRefLabel,
  syncDescription,
  worktreeChanges,
  worktreeDescription,
  type DisplayRef,
  type PullRequestState,
  type RowChip,
  type RowWorktree,
  type Selection,
  type StashEntry,
} from "./commit-graph"
import { LabelText, OperationMenuItems } from "./commit-operation-menu"
import { sameRef } from "./use-graph-selection"
import {
  CHIP_ICONS,
  OPERATION_GROUPS,
  type Label,
  type OperationGroup,
  type OperationRequest,
  type RefMenuComponents,
  type RepositoryState,
} from "./commit-operations"

export type ChipMenuContext = {
  copyText: (value: string) => void
  openPullRequest: (url: string) => void
  openRefDiff: (reference: string) => void
  openStashDiff: (entry: StashEntry) => void
  openWorkingTree: (worktree: RowWorktree) => void
  openWorktree: (path: string, target: WorktreeTarget) => void
  openWorktreeDiff: (worktree: RowWorktree) => void
  repository: RepositoryState | null
  selectRef: (ref: DisplayRef, sha: string) => void
  selectedRef: { ref: DisplayRef; sha: string } | null
  selection: Selection | null
  setRequest: (request: OperationRequest) => void
}

export const contextMenuComponents: RefMenuComponents = {
  Item: ContextMenuItem,
  Label: ContextMenuLabel,
  Separator: ContextMenuSeparator,
  Sub: ContextMenuSub,
  SubContent: ContextMenuSubContent,
  SubTrigger: ContextMenuSubTrigger,
}
export const dropdownMenuComponents: RefMenuComponents = {
  Item: DropdownMenuItem,
  Label: DropdownMenuLabel,
  Separator: DropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubContent: DropdownMenuSubContent,
  SubTrigger: DropdownMenuSubTrigger,
}
export const SELECTION_LABELS = {
  branch: "Branch",
  remote: "Remote branch",
  tag: "Tag",
}
// Destructive operations sit at the bottom of a menu, after anything that only reads the repository.
export const DANGER_GROUPS: OperationGroup[] = ["danger"]
export const SAFE_GROUPS = OPERATION_GROUPS.filter(
  (group) => !DANGER_GROUPS.includes(group),
)
const PULL_REQUEST_ICONS = {
  open: GitPullRequest,
  draft: GitPullRequestDraft,
  merged: GitMerge,
  closed: GitPullRequestClosed,
}

function pullRequestIcon(state: PullRequestState) {
  const Icon = PULL_REQUEST_ICONS[state]
  return <Icon />
}

export function menuHeader(
  { Label, Separator }: RefMenuComponents,
  name: Label,
  detail?: string | null,
) {
  return (
    <>
      <Label>
        <span className="block max-w-80 text-foreground">
          <LabelText label={name} />
        </span>
        {detail && (
          <span className="block max-w-80 truncate font-normal">{detail}</span>
        )}
      </Label>
      <Separator />
    </>
  )
}

function refMenuItems(
  menus: ChipMenuContext,
  ref: DisplayRef,
  sha: string,
  components: RefMenuComponents,
) {
  return (
    <>
      {menuHeader(
        components,
        { kind: ref.kind, name: refName(ref) },
        syncDescription(ref) ?? SELECTION_LABELS[ref.kind],
      )}
      {refMenuActions(menus, ref, sha, components)}
    </>
  )
}

export function refMenuActions(
  menus: ChipMenuContext,
  ref: DisplayRef,
  sha: string,
  components: RefMenuComponents,
  { showCompare = true }: { showCompare?: boolean } = {},
) {
  const { Item, Sub, SubContent, SubTrigger } = components
  const reference = refName(ref)
  const pullRequest = ref.pullRequest
  return (
    <>
      <OperationMenuItems
        components={components}
        groups={SAFE_GROUPS}
        onSelect={menus.setRequest}
        repository={menus.repository}
        source={menus.selection}
        target={refSelection(ref, sha)}
      />
      {showCompare && reference !== menus.repository?.defaultBranch && (
        <Item onSelect={() => menus.openRefDiff(reference)}>
          <FileDiff />
          {`Compare with ${menus.repository?.defaultBranch ?? "the default branch"}`}
        </Item>
      )}
      <Item onSelect={() => menus.copyText(reference)}>
        <Copy />
        {`Copy ${SELECTION_LABELS[ref.kind].toLowerCase()} name`}
      </Item>
      {pullRequest && (
        <Item onSelect={() => menus.openPullRequest(pullRequest.url)}>
          {pullRequestIcon(pullRequest.state)}
          {`Open pull request #${pullRequest.number}`}
        </Item>
      )}
      {ref.worktrees.length > 0 && (
        <Sub>
          <SubTrigger>
            <ExternalLink />
            {ref.worktrees.length === 1 && !ref.worktrees[0].isCurrent ?
              <LabelText
                label={{
                  before: "Open ",
                  kind: "worktree",
                  name: ref.worktrees[0].name,
                  after: " in",
                }}
              />
            : "Open in"}
          </SubTrigger>
          <SubContent>
            {ref.worktrees.flatMap((worktree) => {
              const suffix =
                ref.worktrees.length > 1 ? ` (${worktree.name})` : ""
              return [
                <Item
                  key={`${worktree.path}-git-nav`}
                  onSelect={() => menus.openWorktree(worktree.path, "git-nav")}
                >
                  <AppWindow />
                  {`Git Nav${suffix}`}
                </Item>,
                <Item
                  key={`${worktree.path}-vscode`}
                  onSelect={() => menus.openWorktree(worktree.path, "vscode")}
                >
                  <CodeXml />
                  {`VS Code${suffix}`}
                </Item>,
                <Item
                  key={`${worktree.path}-terminal`}
                  onSelect={() => menus.openWorktree(worktree.path, "terminal")}
                >
                  <Terminal />
                  {`Terminal${suffix}`}
                </Item>,
                <Item
                  key={`${worktree.path}-finder`}
                  onSelect={() => menus.openWorktree(worktree.path, "finder")}
                >
                  <FolderOpen />
                  {`File manager${suffix}`}
                </Item>,
              ]
            })}
          </SubContent>
        </Sub>
      )}
      {ref.worktrees.map((worktree) => (
        <Item
          key={`${worktree.path}-working-tree`}
          onSelect={() => menus.openWorkingTree(worktree)}
        >
          <FilePen />
          {ref.worktrees.length > 1 ?
            `Stage and commit (${worktree.name})`
          : "Stage and commit"}
        </Item>
      ))}
      <OperationMenuItems
        components={components}
        groups={DANGER_GROUPS}
        onSelect={menus.setRequest}
        repository={menus.repository}
        separator="before"
        source={menus.selection}
        target={refSelection(ref, sha)}
      />
    </>
  )
}

function refMenuEntry(
  menus: ChipMenuContext,
  ref: DisplayRef,
  sha: string,
  key: string,
  components: RefMenuComponents,
) {
  const { Item, Sub, SubContent, SubTrigger } = components
  return (
    <Sub key={key}>
      <SubTrigger>
        <LabelText label={{ kind: ref.kind, name: ref.label }} />
      </SubTrigger>
      <SubContent>
        <Item onSelect={() => menus.selectRef(ref, sha)}>
          <GitBranch />
          {`Select ${refName(ref)}`}
        </Item>
        {refMenuItems(menus, ref, sha, components)}
      </SubContent>
    </Sub>
  )
}

function stashMenuItems(
  menus: ChipMenuContext,
  entry: StashEntry,
  components: RefMenuComponents,
) {
  const { Item } = components
  return (
    <>
      {menuHeader(
        components,
        { kind: "stash", name: entry.name },
        entry.message,
      )}
      <OperationMenuItems
        components={components}
        groups={SAFE_GROUPS}
        onSelect={menus.setRequest}
        repository={menus.repository}
        source={null}
        target={{ kind: "stash", entry }}
      />
      <Item onSelect={() => menus.openStashDiff(entry)}>
        <FileDiff />
        Show stashed changes
      </Item>
      <OperationMenuItems
        components={components}
        groups={DANGER_GROUPS}
        onSelect={menus.setRequest}
        repository={menus.repository}
        separator="before"
        source={null}
        target={{ kind: "stash", entry }}
      />
    </>
  )
}

export function stashMenuEntry(
  menus: ChipMenuContext,
  entry: StashEntry,
  components: RefMenuComponents,
) {
  const { Sub, SubContent, SubTrigger } = components
  return (
    <Sub key={entry.sha}>
      <SubTrigger>
        <LabelText
          label={{
            kind: "stash",
            name: `${entry.name}${entry.branch ? ` · ${entry.branch}` : ""}`,
          }}
        />
      </SubTrigger>
      <SubContent>{stashMenuItems(menus, entry, components)}</SubContent>
    </Sub>
  )
}

function chipMenuItems(
  menus: ChipMenuContext,
  chip: RowChip,
  sha: string,
  components: RefMenuComponents,
) {
  if (chip.kind === "stash") {
    return stashMenuItems(menus, chip.entry, components)
  }
  return chip.kind === "worktree" ?
      worktreeMenuItems(menus, chip.worktree, components)
    : refMenuItems(menus, chip.ref, sha, components)
}

export function chipMenuEntry(
  menus: ChipMenuContext,
  chip: RowChip,
  sha: string,
  key: string,
  components: RefMenuComponents,
) {
  if (chip.kind === "stash") {
    return stashMenuEntry(menus, chip.entry, components)
  }
  return chip.kind === "worktree" ?
      worktreeMenuEntry(menus, chip.worktree, components)
    : refMenuEntry(menus, chip.ref, sha, key, components)
}

function worktreeMarker(worktree: RowWorktree) {
  const changes = worktreeChanges(worktree)
  const classes = [
    "commit-ref-worktree",
    worktree.isOpen && "commit-ref-worktree-open",
    worktree.pendingOperation && "commit-ref-worktree-pending",
  ]
    .filter(Boolean)
    .join(" ")
  return (
    <span className={classes} key={worktree.path}>
      <span className="commit-ref-worktree-icon">
        <AppWindow />
      </span>
      {changes > 0 && (
        <span className="commit-ref-worktree-changes">
          <FilePen />
          <span className="commit-ref-worktree-count">{changes}</span>
        </span>
      )}
    </span>
  )
}

function worktreeOpenItems(
  menus: ChipMenuContext,
  worktree: RowWorktree,
  { Item, Sub, SubContent, SubTrigger }: RefMenuComponents,
) {
  return (
    <Sub>
      <SubTrigger>
        <ExternalLink />
        Open in
      </SubTrigger>
      <SubContent>
        <Item onSelect={() => menus.openWorktree(worktree.path, "git-nav")}>
          <AppWindow />
          Git Nav
        </Item>
        <Item onSelect={() => menus.openWorktree(worktree.path, "vscode")}>
          <CodeXml />
          VS Code
        </Item>
        <Item onSelect={() => menus.openWorktree(worktree.path, "terminal")}>
          <Terminal />
          Terminal
        </Item>
        <Item onSelect={() => menus.openWorktree(worktree.path, "finder")}>
          <FolderOpen />
          File manager
        </Item>
      </SubContent>
    </Sub>
  )
}

function worktreeMenuItems(
  menus: ChipMenuContext,
  worktree: RowWorktree,
  components: RefMenuComponents,
) {
  const { Item } = components
  const changes = worktreeChanges(worktree)
  return (
    <>
      {menuHeader(
        components,
        { kind: "worktree", name: worktree.name },
        worktreeDescription(worktree),
      )}
      {changes > 0 && (
        <Item onSelect={() => menus.openWorktreeDiff(worktree)}>
          <FileDiff />
          {`Show ${changes} uncommitted change${changes === 1 ? "" : "s"}`}
        </Item>
      )}
      <Item onSelect={() => menus.openWorkingTree(worktree)}>
        <FilePen />
        Stage and commit
      </Item>
      {worktreeOpenItems(menus, worktree, components)}
    </>
  )
}

function worktreeMenuEntry(
  menus: ChipMenuContext,
  worktree: RowWorktree,
  components: RefMenuComponents,
) {
  const { Sub, SubContent, SubTrigger } = components
  return (
    <Sub key={worktree.path}>
      <SubTrigger>
        <LabelText label={{ kind: "worktree", name: worktree.name }} />
      </SubTrigger>
      <SubContent>{worktreeMenuItems(menus, worktree, components)}</SubContent>
    </Sub>
  )
}

function chipAriaLabel(chip: RowChip) {
  if (chip.kind === "stash") {
    return `Show the changes in ${chip.entry.name}`
  }
  if (chip.kind === "worktree") {
    const changes = worktreeChanges(chip.worktree)
    return changes > 0 ?
        `Show ${changes} uncommitted change${changes === 1 ? "" : "s"} in ${chip.worktree.name}`
      : `The ${chip.worktree.name} worktree`
  }
  return (
    chip.ref.checkedOut ? "Currently checked out"
    : chip.ref.worktrees.length > 0 ?
      `Checked out in the ${chip.ref.worktrees[0].name} worktree`
    : undefined
  )
}

function chipTitle(chip: RowChip) {
  if (chip.kind === "stash") {
    return [
      chip.entry.name,
      chip.entry.message,
      chip.entry.branch && `On ${chip.entry.branch}`,
    ]
      .filter(Boolean)
      .join("\n")
  }
  if (chip.kind === "worktree") {
    return worktreeDescription(chip.worktree)
  }
  return [
    chip.ref.label,
    pullRequestDescription(chip.ref),
    syncDescription(chip.ref),
    ...chip.ref.worktrees.map(worktreeDescription),
  ]
    .filter(Boolean)
    .join("\n")
}

export function rowChip(
  menus: ChipMenuContext,
  chip: RowChip,
  sha: string,
  key?: string,
) {
  const Icon = CHIP_ICONS[chip.kind]
  const ref =
    chip.kind === "stash" || chip.kind === "worktree" ? null : chip.ref
  // A ref name is distinguished by its tail, so the middle of it goes first. A stash message and a worktree
  // name read the other way round and keep their opening characters instead.
  const { start, end } =
    ref ? splitRefLabel(ref.label) : { start: chipLabel(chip), end: "" }
  const sync = ref && refSyncLabel(ref)
  const pullRequest = ref?.pullRequest ?? null
  // A worktree holding no branch is a chip of its own; one holding a branch is a marker inside that chip.
  const chipWorktrees =
    chip.kind === "worktree" ? [chip.worktree] : (ref?.worktrees ?? [])
  const selected =
    ref !== null &&
    menus.selectedRef !== null &&
    sameRef(menus.selectedRef.ref, ref) &&
    menus.selectedRef.sha === sha
  // Neither a stash nor a worktree has a place in a selection, so their chips go straight to their changes.
  const activate = () => {
    if (chip.kind === "stash") {
      return menus.openStashDiff(chip.entry)
    }
    if (chip.kind === "worktree") {
      return worktreeChanges(chip.worktree) > 0 ?
          menus.openWorktreeDiff(chip.worktree)
        : undefined
    }
    return menus.selectRef(chip.ref, sha)
  }
  return (
    <ContextMenu key={key}>
      <Tooltip>
        {/* Radix context menu triggers do not stop propagation, so the row menu would open on top of this one. */}
        <ContextMenuTrigger
          asChild
          onContextMenu={(event) => event.stopPropagation()}
        >
          <TooltipTrigger asChild>
            <button
              aria-label={chipAriaLabel(chip)}
              aria-pressed={ref === null ? undefined : selected}
              className={cn(
                "commit-ref",
                `commit-ref-${chip.kind}`,
                ref?.checkedOut && "commit-ref-current",
                chip.kind === "worktree" &&
                  !chip.worktree.branch &&
                  "commit-ref-detached",
                selected && "commit-ref-selected",
              )}
              // Keyboard activation arrives as a click with no pointer behind it.
              onClick={(event) => event.detail === 0 && activate()}
              onPointerDown={(event) => {
                event.stopPropagation()
                // Acting on click would also answer the stray click a context menu leaves behind when it closes over this chip.
                if (event.button === 0) {
                  activate()
                }
              }}
              type="button"
            >
              {ref?.checkedOut && <span className="commit-ref-head">HEAD</span>}
              {chipWorktrees.map(worktreeMarker)}
              <Icon />
              <span className="commit-ref-label">
                <span className="commit-ref-label-start">{start}</span>
                {end && <span className="commit-ref-label-end">{end}</span>}
              </span>
              {pullRequest && (
                <span
                  className={`commit-ref-pull-request commit-ref-pull-request-${pullRequest.state}`}
                >
                  {pullRequestIcon(pullRequest.state)}
                  {`#${pullRequest.number}`}
                </span>
              )}
              {sync && (
                <span
                  className={cn(
                    "commit-ref-sync",
                    ref?.sync?.isGone && "commit-ref-sync-gone",
                  )}
                >
                  {sync}
                </span>
              )}
            </button>
          </TooltipTrigger>
        </ContextMenuTrigger>
        <TooltipContent>{chipTitle(chip)}</TooltipContent>
      </Tooltip>
      <ContextMenuContent>
        {chipMenuItems(menus, chip, sha, contextMenuComponents)}
      </ContextMenuContent>
    </ContextMenu>
  )
}
