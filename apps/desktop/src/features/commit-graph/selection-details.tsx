import { useQuery } from "@tanstack/react-query"
import { Hinted } from "@/components/hinted"
import { FileStat, FileStatusLetter } from "@/features/diff/file-stat"
import { invoke } from "@/lib/ipc"
import { EMPTY_TREE_REF } from "@/lib/repository-constants"
import { Button } from "@workspace/shadcn/components/button"
import { cn } from "@workspace/shadcn/lib/utils"
import { AppWindow, Copy } from "lucide-react"
import { memo, type ReactNode } from "react"

import {
  pullRequestDescription,
  relativeDate,
  syncDescription,
  worktreeDescription,
  type Commit,
  type CommitSelection,
  type RefSelection,
  type Selection,
} from "./commit-graph"
import { OperationMenuItems } from "./commit-operation-menu"
import { rangeBaseHash } from "./selection-diff"
import type { RefMenuComponents } from "./commit-operations"
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
  body: string
}

type DiffStatFile = {
  path: string
  oldPath: string | null
  status: string
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
  // The sheet already names the selection in its header.
  Label: () => null,
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
        {files.slice(0, 200).map((file) => (
          <li key={file.path}>
            <button
              className="diff-file"
              onClick={() => onOpen(file.path)}
              title={
                file.oldPath ? `${file.oldPath} → ${file.path}` : file.path
              }
              type="button"
            >
              <FileStatusLetter letter={file.status} />
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
        {files.length > 200 && (
          <li className="commit-graph-details-more">{`and ${files.length - 200} more`}</li>
        )}
      </ul>
    </section>
  )
}

function useDiffStat(repoPath: string, base: string | null, head: string) {
  return useQuery({
    enabled: base !== null,
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
  menus,
  onOpenFile,
  repoPath,
  selectCommit,
}: {
  canSelectCommit: (hash: string) => boolean
  commit: Commit
  menus: ChipMenuContext
  onOpenFile: (path: string) => void
  repoPath: string
  selectCommit: (hash: string) => void
}) {
  const details = useQuery({
    enabled: true,
    queryFn: () =>
      invoke<CommitDetails>("commit_details", { repoPath, hash: commit.hash }),
    queryKey: ["commit-details", repoPath, commit.hash],
    retry: false,
    staleTime: Infinity,
  })
  const files = useDiffStat(
    repoPath,
    commit.parents[0] ?? EMPTY_TREE_REF,
    commit.hash,
  )
  const body = details.data?.body.trim()
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
  onOpenFile,
  repoPath,
  selectCommit,
  selection,
}: {
  canSelectCommit: (hash: string) => boolean
  onOpenFile: (path: string) => void
  repoPath: string
  selectCommit: (hash: string) => void
  selection: CommitSelection
}) {
  const files = useDiffStat(
    repoPath,
    rangeBaseHash(selection),
    selection.tip.hash,
  )
  return (
    <>
      {selection.branches.length > 0 && (
        <dl className="commit-graph-details-fields">
          <Field label="On">
            <span className="truncate">
              {selection.branches.map(({ branch }) => branch).join(", ")}
            </span>
          </Field>
        </dl>
      )}
      <section className="commit-graph-details-section">
        <h3 className="commit-graph-details-heading">
          {`${selection.commits.length} commits`}
        </h3>
        <ul className="commit-graph-details-commits">
          {selection.commits.slice(0, 100).map((commit) => (
            <li key={commit.hash}>
              <CommitLink
                canSelect={canSelectCommit(commit.hash)}
                hash={commit.hash}
                selectCommit={selectCommit}
              />
              <span className="truncate" title={commit.subject}>
                {commit.subject || "(no subject)"}
              </span>
            </li>
          ))}
          {selection.commits.length > 100 && (
            <li className="commit-graph-details-more">{`and ${selection.commits.length - 100} more`}</li>
          )}
        </ul>
      </section>
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
      <p className="commit-graph-details-error">{String(error)}</p>
    </section>
  )
}

export const SelectionDetails = memo(function SelectionDetails({
  canSelectCommit,
  menus,
  openSelectionDiff,
  repoPath,
  selectCommit,
  selection,
}: {
  canSelectCommit: (hash: string) => boolean
  menus: ChipMenuContext
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
  return (
    <div className="commit-graph-details">
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
          menus={menus}
          onOpenFile={openDiff}
          repoPath={repoPath}
          selectCommit={selectCommit}
        />
      : <RangeBody
          canSelectCommit={canSelectCommit}
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
            refMenuActions(menus, selection.ref, selection.sha, listComponents)
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
  )
})
