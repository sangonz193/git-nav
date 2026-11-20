import assert from "node:assert/strict"
import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query"
import { mockIPC } from "@tauri-apps/api/mocks"
import type { IDockviewPanelProps } from "dockview-react"
import { type HTMLElement as TestElement, Window } from "happy-dom"
import { act, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"

import type { GraphPanelParams } from "../../../lib/panel-params"
import type { CommitBatch } from "../commit-graph"

const mode = process.argv[2]
const linked = mode === "linked"
const rename = mode.startsWith("rename-")
const testingStash = mode === "stash"
const filtered = mode === "filtered" || linked || rename
const testingRefresh = mode === "refresh" || filtered
const browser = mode === "browser"
const window = new Window({ url: "http://localhost" })
Object.assign(globalThis, {
  window,
  document: window.document,
  localStorage: window.localStorage,
  ResizeObserver: window.ResizeObserver,
  DOMRect: window.DOMRect,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLFormElement: window.HTMLFormElement,
  NodeFilter: window.NodeFilter,
  MutationObserver: window.MutationObserver,
  CustomEvent: window.CustomEvent,
  KeyboardEvent: window.KeyboardEvent,
  Element: window.Element,
  Node: window.Node,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
})
Object.defineProperties(window.HTMLElement.prototype, {
  clientHeight: { get: () => 360 },
  offsetHeight: { get: () => 360 },
  offsetWidth: { get: () => 950 },
})
window.HTMLCanvasElement.prototype.getContext = () => null

onlineManager.setOnline(mode !== "offline")

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
const tracked = {
  branch: "feature",
  upstream: "origin/feature",
  isGone: false,
  ahead: 0,
  behind: 0,
}
const gone = (branch: string) => ({ ...tracked, branch, isGone: true })
let branchStatus: Promise<unknown[]> | unknown[] = [tracked, gone("old")]
const pullRequest = {
  branch: "feature",
  remote: "origin",
  number: 1,
  state: "open",
  host: "github.com",
  repository: "org/app",
  title: "Feature",
  url: "https://github.com/org/app/pull/1",
}
let pullRequests: Promise<unknown[]> | unknown[] =
  linked ? [{ ...pullRequest, branch: "other" }] : []
let changedFiles = 0
let cleanupReads = 0
let fastForwardReads = 0
const stash = {
  base: null,
  branch: null,
  date: "2026-01-01",
  message: "Saved changes",
  name: "stash@{0}",
  sha: "saved",
}
let stashes = testingStash ? [stash, { ...stash, name: "stash@{1}" }] : []

const streams: { id: number; reject: (error: string) => void }[] = []
const done = { done: { hasMore: false } }
const mockCommands = {
  invoke(command: string, args?: unknown) {
    switch (command) {
      case "project_snapshot":
        return {
          worktrees:
            testingRefresh || testingStash || browser ? [] : [worktree],
        }
      case "worktree_status":
        return testingRefresh || testingStash || browser ? [] : status.promise
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
        return branchStatus
      case "branch_pull_requests":
        return pullRequests
      case "stash_list":
        return stashes
      case "inferred_squash_merge_edges":
        return []
      case "settings":
        return {}
      case "repository_fingerprint":
        return "unchanged"
      case "watch_repository":
        return {
          projectId: repoPath,
          autoFetch: false,
          fetch: idle,
          pullRequests: idle,
        }
      case "stream_commit_graph": {
        const { onBatch } = args as { onBatch: { id: number } }
        if (testingRefresh) {
          const invoke = Promise.withResolvers<void>()
          streams.push({ id: onBatch.id, reject: invoke.reject })
          if (streams.length !== 2) invoke.resolve()
          return invoke.promise
        }
        Reflect.get(window, "__TAURI_INTERNALS__").runCallback(onBatch.id, {
          index: 0,
          message: done,
        })
        return null
      }
      case "repository_state":
      case "unwatch_repository":
        return null
      default:
        throw new Error(`Unexpected command: ${command}`)
    }
  },
}

const browserStreams: GraphEventSource[] = []
class GraphEventSource extends EventTarget {
  readonly offset: number
  closed = false

  constructor(url: string) {
    super()
    this.offset = Number(
      new URL(url, window.location.href).searchParams.get("offset"),
    )
    browserStreams.push(this)
  }

  close() {
    this.closed = true
  }

  send(type: string, data: unknown) {
    assert.ok(!this.closed)
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }))
  }
}

if (browser) {
  Object.assign(globalThis, {
    EventSource: GraphEventSource,
    fetch: async (url: string) =>
      Response.json(await mockCommands.invoke(url.slice("/api/".length))),
  })
} else {
  mockIPC(mockCommands.invoke, { shouldMockEvents: true })
}

const { useGraphData } = await import("../use-graph-data")
const { useBranchCleanup } = await import("../use-branch-cleanup")
const { useBranchFastForward } = await import("../use-branch-fast-forward")

export function Harness() {
  const graph = useGraphData({ onError: noop, repoPath })
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
document.body.append(container)
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

async function testBadges() {
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
}

function refs(n: number) {
  if (!filtered || [9, 11].includes(n)) return []
  if (rename && Math.abs(n - 900) === 1) return []
  if (rename && n === 900)
    return [`refs/heads/${streams.length >= 3 ? "new" : "old"}`]
  return [n === 10 ? "refs/heads/feature" : `tag: refs/tags/v${n}`]
}

function batch(start: number, count: number) {
  return {
    batch: Array.from({ length: count }, (_, index): CommitBatch[number] => {
      const n = start + index
      return [
        `commit-${n}`,
        [`commit-${n + 1}`],
        "Ada",
        "2026-01-01",
        refs(n),
        `Subject ${n}`,
        0,
        [0],
        1,
        [0],
        [true],
      ]
    }),
  }
}

async function testStashMenu() {
  const trigger = container.querySelector('[aria-haspopup="menu"]')!
  const key = (value: string) =>
    new KeyboardEvent("keydown", { bubbles: true, key: value })
  const stashTrigger = (index: number) =>
    [
      ...document.querySelectorAll('[role="menuitem"][aria-haspopup="menu"]'),
    ].find((item) => item.textContent === `stash@{${index}}`)
  const submenu = () => document.querySelectorAll('[role="menu"]')[1]

  await act(async () => trigger.dispatchEvent(key("Enter")))
  const first = stashTrigger(0)!
  const second = stashTrigger(1)!
  await act(async () => first.dispatchEvent(key("ArrowRight")))
  const open = submenu()
  assert.ok(open?.textContent?.includes("Show stashed changes"))

  await act(async () => {
    stashes = [
      { ...stash, sha: "new", message: "New changes" },
      { ...stash, name: "stash@{1}" },
      { ...stash, name: "stash@{2}" },
    ]
    window.dispatchEvent(new window.Event("focus"))
  })
  assert.ok(submenu() === open, "the same submenu stays open")
  assert.ok(
    open.textContent?.includes("stash@{1}"),
    "the open stash is renumbered",
  )
  assert.ok(stashTrigger(1) === first, "first occurrence keeps its trigger")
  assert.ok(stashTrigger(2) === second, "second occurrence keeps its trigger")
}

async function testRefresh() {
  const { CommitGraphPanel } = await import("../commit-graph-panel")
  const { TooltipProvider } =
    await import("@workspace/shadcn/components/tooltip")
  const props = {
    api: {
      id: "app",
      onDidVisibilityChange: () => ({ dispose() {} }),
      updateParameters() {},
    },
    containerApi: {},
    params: {
      name: "app",
      path: "/app",
      userPreferences: { collapseUnmarked: filtered },
    },
  } as unknown as IDockviewPanelProps<GraphPanelParams>
  function send(
    stream: number,
    index: number,
    message: ReturnType<typeof batch> | typeof done,
  ) {
    Reflect.get(window, "__TAURI_INTERNALS__").runCallback(streams[stream].id, {
      index,
      message,
    })
  }
  const grid = () =>
    window.document.querySelector<TestElement>(".commit-graph-scroll")!
  const row = (subject: number) =>
    [...grid().querySelectorAll("article")].find((row) =>
      row.textContent.includes(`Subject ${subject}Ada`),
    )
  const key = (value: string) =>
    new window.KeyboardEvent("keydown", { bubbles: true, key: value })
  const refresh = () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Refresh graph"]')!
      .click()

  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <CommitGraphPanel {...props} />
        </TooltipProvider>
      </QueryClientProvider>,
    )
  })
  if (testingStash) return testStashMenu()
  if (filtered) {
    const button = (label: string) =>
      [...window.document.querySelectorAll("button")].find(
        (el) => el.textContent === label,
      )!
    const view = button("View")
    await act(async () => view.click())
    await act(async () => button(linked ? "Linked" : "Gone").click())
    await act(async () => view.click())
  }
  await act(async () => send(0, 0, batch(0, 500)))
  assert.ok(row(0), "initial batches render before completion")
  await act(async () => send(0, 1, batch(500, 500)))
  const initialTop = (filtered ? 898 : 900) * 32 + 7
  await act(async () => {
    grid().scrollTop = initialTop
    grid().dispatchEvent(new window.Event("scroll"))
  })
  const visible = row(900)!
  assert.ok(visible)
  await act(async () => {
    visible.dispatchEvent(key("Enter"))
    visible.dispatchEvent(
      new window.MouseEvent("contextmenu", { bubbles: true }),
    )
  })
  const openMenu = () => window.document.querySelector('[role="menu"]')
  const menu = openMenu()
  assert.ok(menu)
  await act(async () => refresh())
  await act(async () => send(1, 0, batch(-200, 500)))
  await act(async () => streams[1].reject("git log failed"))
  assert.ok(container.textContent.includes("git log failed"))
  assert.ok(row(900) === visible)
  assert.equal(openMenu(), menu)

  if (linked) pullRequests = status.promise
  else if (filtered) branchStatus = status.promise
  await act(async () => refresh())
  await act(async () => send(2, 0, batch(-100, 500)))
  await act(async () => send(2, 2, done))
  assert.ok(row(900) === visible)
  assert.equal(grid().scrollTop, initialTop)
  const renamed = [gone("feature"), gone("new")]
  const resolveStatus = () =>
    act(async () => status.resolve(linked ? [pullRequest] : renamed))
  if (mode === "rename-status-first") await resolveStatus()
  assert.equal(openMenu(), menu)
  await act(async () => send(2, 1, batch(400, 600)))
  if (filtered && mode !== "rename-status-first") {
    assert.equal(grid().scrollTop, initialTop + (rename ? 0 : 100 * 32))
    assert.equal(openMenu(), menu)
    await resolveStatus()
  }
  assert.equal(grid().scrollTop, 1000 * 32 + 7)
  assert.ok(row(900) === visible)
  assert.equal(openMenu(), menu)
  assert.equal(visible.getAttribute("aria-selected"), "true")
  const canvas = container.querySelector("canvas")!
  assert.equal(canvas.style.transform, "translateY(31911px)")
  await act(async () => refresh())
  await act(async () => send(3, 0, batch(-300, 500)))
  await act(async () => {
    refresh()
    send(3, 1, done)
  })
  assert.equal(grid().scrollTop, 1000 * 32 + 7)
  await act(async () => menu.dispatchEvent(key("Escape")))
  assert.ok(!openMenu())
  assert.equal(streams.length, 5)
  assert.ok(row(900) === visible)
}

async function testBrowserWindows() {
  let graph!: ReturnType<typeof useGraphData>
  function BrowserHarness() {
    const [error, onError] = useState<string | null>(null)
    const current = useGraphData({ onError, repoPath })
    useEffect(() => {
      graph = current
    })
    return <span>{error}</span>
  }
  const source = (offset: number) => {
    const stream = browserStreams.at(-1)!
    assert.equal(stream.offset, offset)
    return stream
  }
  const view = (offset: number, loading: boolean, hash: string) => {
    assert.equal(graph.graphOffset, offset)
    assert.equal(graph.isGraphWindowLoading, loading)
    const hashes = graph.commits.map((commit) => commit.hash)
    assert.deepEqual(hashes, [hash])
  }
  const complete = async (offset: number, hash: number) => {
    const stream = source(offset)
    await act(async () => {
      stream.send("batch", batch(hash, 1).batch)
      stream.send("done", done.done)
    })
  }

  await act(async () => root.render(<BrowserHarness />))
  await complete(0, 0)
  await act(async () => graph.setGraphOffset(2000))
  await complete(2000, 2000)
  assert.equal(graph.graphVersion, 0)

  await act(async () => graph.refreshGraph())
  await act(async () => source(2000).send("done", done.done))
  view(2000, true, "commit-2000")
  await act(async () => source(0).send("failed", "git log failed"))
  view(2000, false, "commit-2000")
  assert.equal(container.textContent, "git log failed")

  await act(async () => graph.refreshGraph())
  const stale = source(2000)
  await act(async () => {
    graph.setGraphOffset(4000)
    stale.send("done", done.done)
  })
  await complete(4000, 4000)
  view(4000, false, "commit-4000")

  await act(async () => {
    graph.setGraphOffset(2000)
    graph.refreshGraph()
  })
  await complete(2000, 2001)
  await act(async () => graph.refreshGraph())
  await act(async () => source(2000).send("done", done.done))
  await act(async () => source(0).send("batch", batch(2, 1).batch))
  view(2000, true, "commit-2001")
  await act(async () => source(0).send("done", done.done))
  view(0, false, "commit-2")
  assert.equal(graph.graphVersion, 3)
}

try {
  if (testingRefresh || testingStash) await testRefresh()
  else if (browser) await testBrowserWindows()
  else await testBadges()
} finally {
  await act(async () => root.unmount())
  client.clear()
  await window.happyDOM.close()
}
