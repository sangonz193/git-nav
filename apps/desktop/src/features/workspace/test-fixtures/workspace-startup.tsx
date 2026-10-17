import assert from "node:assert/strict"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { emit } from "@tauri-apps/api/event"
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks"
import { Window } from "happy-dom"
import { act, useLayoutEffect } from "react"
import { createRoot } from "react-dom/client"
import type { ProjectWorktree, WorkspaceState } from "../workspace"

const window = new Window()
Object.assign(globalThis, {
  window,
  document: window.document,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const first = { project: "/code/app/.git", worktree: "/code/app-fix" }
const second = { project: "/code/other/.git", worktree: "/code/other" }
let projects = [first, second].map((active) => ({
  id: active.project,
  path: active.worktree,
}))
const routes = new Map<string, ProjectWorktree | null>([["main", first]])
const saved: WorkspaceState[] = []
const cleared: string[] = []
const pending = [first]
let releaseFlush = () => {}
let flushGate = new Promise<void>((resolve) => (releaseFlush = resolve))
const layoutFlush = { current: () => flushGate }
const requests: string[] = []

function select(target: ProjectWorktree, source: string) {
  const existing = [...routes].find(
    ([, active]) => active?.worktree === target.worktree,
  )?.[0]
  const label = existing ?? source
  routes.set(label, target)
  return label
}

mockWindows("main")
mockIPC(
  async (command, args) => {
    requests.push(command)
    if (command === "sidebar_projects") return projects
    if (command === "window_session") return { active: null }
    if (command === "take_opened_repositories") return pending.splice(0)
    if (command === "save_window_worktree") {
      saved.push(args as WorkspaceState)
      return
    }
    if (command === "clear_window_worktree") {
      const { worktree } = args as { worktree: string }
      cleared.push(worktree)
      if (routes.get("main")?.worktree === worktree) routes.set("main", null)
      return
    }
    if (command === "open_repository") {
      const target =
        (args as { path: string }).path === first.worktree ? first : second
      if (select(target, "main") === "main") {
        pending.push(target)
        await emit("repositories-opened")
      }
      return
    }
    if (command === "open_repository_in_new_window") {
      routes.set("window-2", routes.get("main") ?? null)
      return
    }
    if (command === "remove_sidebar_project") {
      projects = projects.filter(
        ({ id }) => id !== (args as { project: string }).project,
      )
      return
    }
    throw new Error(`Unexpected command: ${command}`)
  },
  { shouldMockEvents: true },
)

const { useWorkspace } = await import("../use-workspace")
let workspace: ReturnType<typeof useWorkspace> | undefined
export function Harness() {
  const value = useWorkspace(layoutFlush)
  useLayoutEffect(() => {
    workspace = value
  })
  return null
}
const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
})
const root = createRoot(document.createElement("div"))
await act(async () => {
  root.render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  )
})
assert.ok(workspace)
assert.ok(requests.includes("take_opened_repositories"))
assert.deepEqual(saved, [{ active: null }])
assert.deepEqual(cleared, [])
assert.equal(select(first, "other-window"), "main")

await act(async () => {
  releaseFlush()
  flushGate = Promise.resolve()
})
assert.deepEqual(workspace.state, { active: first })
assert.deepEqual(saved, [{ active: null }, { active: first }])
assert.equal(select(first, "other-window"), "main")

await act(async () => workspace!.show(second))
assert.deepEqual(workspace.state, { active: second })
assert.equal(select(second, "other-window"), "main")
assert.deepEqual(cleared, [])

await act(async () => workspace!.show(null))
assert.deepEqual(workspace.state, { active: null })
assert.deepEqual(cleared, [second.worktree])
assert.equal(routes.get("main"), null)
assert.deepEqual(saved.at(-1), { active: null })

await act(async () => workspace!.show(first))
await act(async () => workspace!.remove(first.project))
assert.deepEqual(workspace.state, { active: second })
assert.deepEqual(routes.get("main"), second)
assert.deepEqual(cleared, [second.worktree, first.worktree])
await act(async () => workspace!.remove(second.project))
assert.deepEqual(workspace.state, { active: null })
assert.equal(routes.get("main"), null)
assert.deepEqual(cleared, [second.worktree, first.worktree, second.worktree])

await act(async () => workspace!.show(first))
await act(async () => workspace!.openInNewWindow(first))
assert.deepEqual(workspace.state, { active: null })
assert.equal(routes.get("main"), null)
assert.equal(select(first, "other-window"), "window-2")
assert.deepEqual(cleared, [
  second.worktree,
  first.worktree,
  second.worktree,
  first.worktree,
])

await act(async () => root.unmount())
client.clear()
await window.happyDOM.close()
