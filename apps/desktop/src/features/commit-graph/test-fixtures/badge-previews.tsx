import assert from "node:assert/strict"
import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query"
import { mockIPC } from "@tauri-apps/api/mocks"
import { Window } from "happy-dom"
import { act } from "react"
import { createRoot } from "react-dom/client"

const window = new Window()
Object.assign(globalThis, {
  window,
  document: window.document,
  IS_REACT_ACT_ENVIRONMENT: true,
})
onlineManager.setOnline(process.argv[2] === "online")

const repoPath = "/code/app"
const worktree = { branch: "feature", head: "abc123", path: "/code/feature" }
const cleanOptions = {
  deleteMergedPullRequestBranches: false,
  deleteMergedBranches: true,
  deleteSquashMergedBranches: false,
}
const noop = () => undefined
const status = Promise.withResolvers<unknown[]>()
const idle = {
  isRunning: false,
  completedAt: null,
  succeededAt: null,
  error: null,
}
const actions: string[] = []
let changedFiles = 0
let cleanupReads = 0
let fastForwardReads = 0

mockIPC(
  (command) => {
    switch (command) {
      case "project_snapshot":
        return { worktrees: [worktree] }
      case "worktree_status":
        return status.promise
      case "preview_cleanup_candidates":
        cleanupReads++
        return []
      case "preview_fast_forward_candidates":
        fastForwardReads++
        return [{ ...worktree, blocker: changedFiles ? "dirty" : null }]
      case "delete_squashed_branches":
        actions.push(command)
        return { candidates: [], deleted: [], failed: [] }
      case "fast_forward_merged_branches":
        actions.push(command)
        return { target: "main", moved: [], failed: [], updates: [] }
      case "branch_sync":
      case "branch_pull_requests":
      case "stash_list":
        return []
      case "repository_fingerprint":
        return "unchanged"
      case "watch_repository":
        return {
          projectId: repoPath,
          autoFetch: false,
          fetch: idle,
          pullRequests: idle,
        }
      case "repository_state":
      case "stream_commit_graph":
      case "unwatch_repository":
        return null
      default:
        throw new Error(`Unexpected command: ${command}`)
    }
  },
  { shouldMockEvents: true },
)

const { useGraphData } = await import("../use-graph-data")
const { useBranchCleanup } = await import("../use-branch-cleanup")
const { useBranchFastForward } = await import("../use-branch-fast-forward")

export function Harness() {
  const graph = useGraphData({
    onBeforeReload: noop,
    onError: noop,
    repoPath,
  })
  const options = { ...graph, cleanOptions, repoPath }
  const cleanup = useBranchCleanup(options)
  const fastForward = useBranchFastForward({ ...options, onCompleted: noop })
  return (
    <>
      <button onClick={cleanup.clean} />
      <button onClick={fastForward.fastForward} />
      <output>
        {cleanup.isPreviewPending || fastForward.isPreviewPending ?
          "loading"
        : String(fastForward.candidateCount)}
      </output>
    </>
  )
}

const client = new QueryClient()
const container = document.createElement("div")
const root = createRoot(container)

async function waitForBadge(expected: string) {
  for (
    let attempt = 0;
    attempt < 40 && container.textContent !== expected;
    attempt++
  ) {
    await act(async () => Bun.sleep(5))
  }
  assert.equal(container.textContent, expected)
}

try {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    )
  })
  await waitForBadge("1")
  assert.deepEqual([cleanupReads, fastForwardReads], [1, 1])

  await act(async () => {
    changedFiles = 1
    status.resolve([
      { ...worktree, changedFiles, untrackedFiles: 0, pendingOperation: null },
    ])
  })
  await waitForBadge("0")
  assert.deepEqual([cleanupReads, fastForwardReads], [2, 2])
  await act(async () => {
    for (const button of container.querySelectorAll("button")) button.click()
  })
  assert.deepEqual(actions, [
    "delete_squashed_branches",
    "fast_forward_merged_branches",
  ])
} finally {
  await act(async () => root.unmount())
  client.clear()
  await window.happyDOM.close()
}
