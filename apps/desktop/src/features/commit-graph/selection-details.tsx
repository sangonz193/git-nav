import { useQuery } from "@tanstack/react-query"
import { Hinted } from "@/components/hinted"
import { FileStat } from "@/features/diff/diff-panel"
import { invoke } from "@/lib/ipc"
import { Button } from "@workspace/shadcn/components/button"
import { cn } from "@workspace/shadcn/lib/utils"
import { AppWindow, Copy, FileDiff, X } from "lucide-react"
import { memo, type ReactNode } from "react"

import {
  pullRequestDescription,
  refName,
  relativeDate,
  syncDescription,
  worktreeDescription,
  type Commit,
  type CommitSelection,
  type RefSelection,
  type Selection,
} from "./commit-graph"
import { canDiffSelection } from "./selection-diff"
import { LabelText, OperationMenuItems } from "./commit-operation-menu"
import { selectionLabel, type RefMenuComponents } from "./commit-operations"
import {
  DANGER_GROUPS,
  refMenuActions,
  SAFE_GROUPS,
  type ChipMenuContext,
} from "./row-chips"

type CommitDetails = {
  authorName: string
  authorEmail: string
  authorDate: string
  committerName: string
  committerEmail: string
  committerDate: string
  message: string
}

type DiffStatFile = {
  path: string
  oldPath: string | null
  additions: number | null
  deletions: number | null
}

const listComponents: RefMenuComponents = {
  Item: ({ children, className, disabled, onSelect, title }) => (
    <button
      className={cn("commit-graph-details-action", className)}
      disabled={disabled}
      onClick={onSelect}
      title={title}
      type="button"
    >
      {children}
    </button>
  ),
  Label: ({ children }) => (
    <div className="commit-graph-details-action-label">{children}</div>
  ),
  Separator: () => <hr className="commit-graph-details-separator" />,
  Sub: ({ children }) => <div>{children}</div>,
  SubContent: ({ children }) => (
    <div className="commit-graph-details-sub">{children}</div>
  ),
  SubTrigger: ({ children }) => (
    <div className="commit-graph-details-action-label">{children}</div>
  ),
}

function absoluteDate(value: string) {
  const milliseconds = Date.parse(value)
  return Number.isNaN(milliseconds) ? value : (
      new Date(milliseconds).toLocaleString()
    )
}

function Field({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="commit-graph-details-field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function Person({
  date,
  email,
  name,
}: {
  date: string
  email: string
  name: string
}) {
  return (
    <>
      <span className="truncate" title={email}>
        {name}
      </span>
      <time
        className="text-muted-foreground"
        dateTime={date}
        title={absoluteDate(date)}
      >
        {relativeDate(date)}
      </time>
    </>
  )
}

function FileList({
  files,
  onOpen,
}: {
  files: DiffStatFile[]
  onOpen: (path: string) => void
}) {
  const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0)
  const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0)
  return (
    <section className="commit-graph-details-section">
      <h3 className="commit-graph-details-heading">
        <span>{`${files.length} file${files.length === 1 ? "" : "s"}`}</span>
        <FileStat additions={additions} deletions={deletions} />
      </h3>
      <ul className="commit-graph-details-files">
        {files.map((file) => (
          <li key={file.path}>
            <button
              className="diff-file"
              onClick={() => onOpen(file.path)}
              title={
                file.oldPath ? `${file.oldPath} → ${file.path}` : file.path
              }
              type="button"
            >
              <span className="commit-graph-details-path">{file.path}</span>
              {file.additions !== null && file.deletions !== null && (
                <FileStat
                  additions={file.additions}
                  deletions={file.deletions}
                />
              )}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function useDiffStat(
  repoPath: string,
  base: string | null,
  head: string,
  enabled = true,
) {
  return useQuery({
    enabled: enabled && base !== null,
    queryFn: () =>
      invoke<DiffStatFile[]>("diff_stat", { repoPath, base, head }),
    queryKey: ["diff-stat", repoPath, base, head],
    retry: false,
    staleTime: Infinity,
  })
}

function CommitBody({
  canSelectCommit,
  commit,
  isRangeDragging,
  menus,
  onOpenFile,
  repoPath,
  selectCommit,
}: {
  canSelectCommit: (hash: string) => boolean
  commit: Commit
  isRangeDragging: boolean
  menus: ChipMenuContext
  onOpenFile: (path: string) => void
  repoPath: string
  selectCommit: (hash: string) => void
}) {
  const details = useQuery({
    enabled: !isRangeDragging,
    queryFn: () =>
      invoke<CommitDetails>("commit_details", { repoPath, hash: commit.hash }),
    queryKey: ["commit-details", repoPath, commit.hash],
    retry: false,
    staleTime: Infinity,
  })
  const files = useDiffStat(
    repoPath,
    commit.parents[0] ?? null,
    commit.hash,
    !isRangeDragging,
  )
  const body = details.data?.message
    .split(/\r?\n\r?\n/)
    .slice(1)
    .join("\n\n")
    .trim()
  const committerDiffers =
    details.data &&
    (details.data.committerName !== details.data.authorName ||
      details.data.committerEmail !== details.data.authorEmail)
  return (
    <>
      <section className="commit-graph-details-section">
        <p className="font-medium wrap-break-word">
          {commit.subject || "(no subject)"}
        </p>
        {body && (
          <p className="commit-graph-details-message text-muted-foreground">
            {body}
          </p>
        )}
      </section>
      <dl className="commit-graph-details-fields">
        <Field label="Author">
          {details.data ?
            <Person
              date={details.data.authorDate}
              email={details.data.authorEmail}
              name={details.data.authorName}
            />
          : <>
              <span className="truncate">{commit.author}</span>
              <time className="text-muted-foreground" dateTime={commit.date}>
                {relativeDate(commit.date)}
              </time>
            </>
          }
        </Field>
        {committerDiffers && details.data && (
          <Field label="Committer">
            <Person
              date={details.data.committerDate}
              email={details.data.committerEmail}
              name={details.data.committerName}
            />
          </Field>
        )}
        <Field label="Commit">
          <code className="truncate" title={commit.hash}>
            {commit.hash}
          </code>
          <Hinted hint="Copy SHA">
            <Button
              aria-label="Copy SHA"
              onClick={() => menus.copyText(commit.hash)}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <Copy />
            </Button>
          </Hinted>
        </Field>
        {commit.parents.length > 0 && (
          <Field label={commit.parents.length === 1 ? "Parent" : "Parents"}>
            {commit.parents.map((parent) => (
              <CommitLink
                canSelect={canSelectCommit(parent)}
                hash={parent}
                key={parent}
                selectCommit={selectCommit}
              />
            ))}
          </Field>
        )}
      </dl>
      {details.error && <QueryError error={details.error} />}
      {files.data && <FileList files={files.data} onOpen={onOpenFile} />}
      {files.error && <QueryError error={files.error} />}
    </>
  )
}

function RangeBody({
  canSelectCommit,
  isRangeDragging,
  onOpenFile,
  repoPath,
  selectCommit,
  selection,
}: {
  canSelectCommit: (hash: string) => boolean
  isRangeDragging: boolean
  onOpenFile: (path: string) => void
  repoPath: string
  selectCommit: (hash: string) => void
  selection: CommitSelection
}) {
  const oldest = selection.commits.at(-1)!
  const files = useDiffStat(
    repoPath,
    selection.base?.hash ?? null,
    selection.tip.hash,
    !isRangeDragging,
  )
  return (
    <>
      <dl className="commit-graph-details-fields">
        <Field label="Newest">
          <CommitLink
            canSelect={canSelectCommit(selection.tip.hash)}
            hash={selection.tip.hash}
            selectCommit={selectCommit}
          />
          <span className="truncate text-muted-foreground">
            {selection.tip.subject}
          </span>
        </Field>
        <Field label="Oldest">
          <CommitLink
            canSelect={canSelectCommit(oldest.hash)}
            hash={oldest.hash}
            selectCommit={selectCommit}
          />
          <span className="truncate text-muted-foreground">
            {oldest.subject}
          </span>
        </Field>
        {selection.branches.length > 0 && (
          <Field label="On">
            <span className="truncate">
              {selection.branches.map(({ branch }) => branch).join(", ")}
            </span>
          </Field>
        )}
      </dl>
      {files.data && <FileList files={files.data} onOpen={onOpenFile} />}
      {files.error && <QueryError error={files.error} />}
    </>
  )
}

function RefBody({
  canSelectCommit,
  menus,
  selectCommit,
  selection,
}: {
  canSelectCommit: (hash: string) => boolean
  menus: ChipMenuContext
  selectCommit: (hash: string) => void
  selection: RefSelection
}) {
  const { ref } = selection
  const pullRequest = ref.pullRequest
  return (
    <dl className="commit-graph-details-fields">
      <Field label="Commit">
        <CommitLink
          canSelect={canSelectCommit(selection.sha)}
          hash={selection.sha}
          selectCommit={selectCommit}
        />
      </Field>
      {ref.sync && (
        <Field label="Upstream">
          <span className="truncate">{syncDescription(ref)}</span>
        </Field>
      )}
      {pullRequest && (
        <Field label="Pull request">
          <button
            className="commit-graph-details-link truncate"
            onClick={() => menus.openPullRequest(pullRequest.url)}
            title={pullRequestDescription(ref) ?? undefined}
            type="button"
          >
            {`#${pullRequest.number} ${pullRequest.title}`}
          </button>
        </Field>
      )}
      {ref.worktrees.map((worktree) => (
        <Field key={worktree.path} label="Worktree">
          <span className="commit-graph-details-worktree">
            <AppWindow />
            <span className="truncate" title={worktree.path}>
              {worktree.name}
            </span>
          </span>
          <span
            className="truncate text-muted-foreground"
            title={worktreeDescription(worktree)}
          >
            {worktreeDescription(worktree).split("\n").slice(1).join(" · ")}
          </span>
        </Field>
      ))}
    </dl>
  )
}

function CommitLink({
  canSelect,
  hash,
  selectCommit,
}: {
  canSelect: boolean
  hash: string
  selectCommit: (hash: string) => void
}) {
  const content = <code>{hash.slice(0, 8)}</code>
  return canSelect ?
      <button
        className="commit-graph-details-link"
        onClick={() => selectCommit(hash)}
        type="button"
      >
        {content}
      </button>
    : content
}

function QueryError({ error }: { error: Error }) {
  return (
    <section className="commit-graph-details-section" role="alert">
      <p className="commit-graph-error">{String(error)}</p>
    </section>
  )
}

export const SelectionDetails = memo(function SelectionDetails({
  canSelectCommit,
  clearSelection,
  isRangeDragging,
  menus,
  onClose,
  openSelectionDiff,
  repoPath,
  selectCommit,
  selection,
}: {
  canSelectCommit: (hash: string) => boolean
  clearSelection: () => void
  isRangeDragging: boolean
  menus: ChipMenuContext
  onClose: () => void
  openSelectionDiff: (selection: Selection, filePath?: string) => void
  repoPath: string
  selectCommit: (hash: string) => void
  selection: Selection
}) {
  const singleCommit =
    selection.kind === "commits" && selection.commits.length === 1 ?
      selection.tip
    : null
  const openDiff = (filePath?: string) => openSelectionDiff(selection, filePath)
  const canDiff = canDiffSelection(selection, menus.repository?.defaultBranch)
  return (
    <aside aria-label="Selection details" className="commit-graph-details">
      <header className="commit-graph-details-header">
        <span className="commit-graph-details-title">
          <LabelText label={selectionLabel(selection)} />
        </span>
        <Hinted hint="Hide details">
          <Button
            aria-label="Hide details"
            onClick={onClose}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <X />
          </Button>
        </Hinted>
      </header>
      <div className="commit-graph-details-body">
        <div className="commit-graph-details-toolbar">
          <Hinted
            hint={
              selection.kind === "commits" ?
                "Diff the selected range"
              : `Diff ${refName(selection.ref)} against the default branch`
            }
          >
            <Button
              disabled={!canDiff}
              onClick={() => openDiff()}
              size="sm"
              type="button"
              variant="outline"
            >
              <FileDiff />
              Diff
            </Button>
          </Hinted>
          <Button
            onClick={clearSelection}
            size="sm"
            type="button"
            variant="ghost"
          >
            <X />
            Clear
          </Button>
        </div>
        {selection.kind !== "commits" ?
          <RefBody
            canSelectCommit={canSelectCommit}
            menus={menus}
            selectCommit={selectCommit}
            selection={selection}
          />
        : singleCommit ?
          <CommitBody
            canSelectCommit={canSelectCommit}
            commit={singleCommit}
            isRangeDragging={isRangeDragging}
            menus={menus}
            onOpenFile={openDiff}
            repoPath={repoPath}
            selectCommit={selectCommit}
          />
        : <RangeBody
            canSelectCommit={canSelectCommit}
            isRangeDragging={isRangeDragging}
            onOpenFile={openDiff}
            repoPath={repoPath}
            selectCommit={selectCommit}
            selection={selection}
          />
        }
        <section className="commit-graph-details-section">
          <h3 className="commit-graph-details-heading">Actions</h3>
          <div className="commit-graph-details-actions">
            {selection.kind !== "commits" ?
              refMenuActions(
                menus,
                selection.ref,
                selection.sha,
                listComponents,
              )
            : <>
                <OperationMenuItems
                  components={listComponents}
                  groups={SAFE_GROUPS}
                  onSelect={menus.setRequest}
                  repository={menus.repository}
                  source={selection}
                  target={selection}
                />
                <listComponents.Item
                  onSelect={() => menus.copyText(selection.tip.hash)}
                >
                  <Copy />
                  Copy SHA
                </listComponents.Item>
                {singleCommit && (
                  <listComponents.Item
                    onSelect={() => menus.copyText(singleCommit.subject)}
                  >
                    <Copy />
                    Copy commit subject
                  </listComponents.Item>
                )}
                <OperationMenuItems
                  components={listComponents}
                  groups={DANGER_GROUPS}
                  onSelect={menus.setRequest}
                  repository={menus.repository}
                  separator="before"
                  source={selection}
                  target={selection}
                />
              </>
            }
          </div>
        </section>
      </div>
    </aside>
  )
})
