import assert from "node:assert/strict"
import {
  notifyManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query"
import { Window } from "happy-dom"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { TooltipProvider } from "@workspace/shadcn/components/tooltip"

const window = new Window({ url: "http://localhost" })
Object.assign(globalThis, {
  window,
  document: window.document,
  sessionStorage: window.sessionStorage,
  localStorage: window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
})
let failing = true
let projects = [
  {
    id: "/code/app/.git",
    name: "Saved project",
    path: "/code/app",
    worktrees: [],
  },
]
globalThis.fetch = Object.assign(
  async (input: Parameters<typeof fetch>[0]) => {
    assert.equal(input, "/api/sidebar_projects")
    return failing ?
        new Response(null, { status: 502 })
      : Response.json(projects)
  },
  { preconnect: globalThis.fetch.preconnect },
)
const { WorkspaceWindow } = await import("../workspace-window")
notifyManager.setScheduler(queueMicrotask)
notifyManager.setNotifyFunction((callback) => {
  act(callback)
})
const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
})
const container = document.createElement("div")
document.body.append(container)
const root = createRoot(container)
await act(async () => {
  root.render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <WorkspaceWindow />
      </TooltipProvider>
    </QueryClientProvider>,
  )
})
async function waitFor(assertion: () => void) {
  const deadline = performance.now() + 2_000
  while (true) {
    try {
      assertion()
      return
    } catch (error) {
      if (
        !(error instanceof assert.AssertionError) ||
        performance.now() >= deadline
      ) {
        throw error
      }
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
  }
}
function errorVisible() {
  assert.match(
    container.querySelector('[role="alert"]')?.textContent ?? "",
    /Could not load projects.*Could not reach the Git Nav server/,
  )
  assert.doesNotMatch(
    container.textContent ?? "",
    /Open a repository to get started/,
  )
}
await waitFor(errorVisible)
failing = false
await act(async () => {
  await client.invalidateQueries({ queryKey: ["sidebar-projects"] })
})
await waitFor(() => {
  assert.equal(container.querySelector('[role="alert"]'), null)
  assert.match(container.textContent ?? "", /Saved project/)
})
failing = true
await act(async () => {
  await client.invalidateQueries({ queryKey: ["sidebar-projects"] })
})
await waitFor(errorVisible)
assert.match(
  container.querySelector('nav[aria-label="Projects"]')?.textContent ?? "",
  /Saved project/,
)
failing = false
await act(async () => {
  await client.invalidateQueries({ queryKey: ["sidebar-projects"] })
})
await waitFor(() => {
  assert.equal(container.querySelector('[role="alert"]'), null)
  assert.match(container.textContent ?? "", /Saved project/)
})
projects = []
await act(async () => {
  await client.invalidateQueries({ queryKey: ["sidebar-projects"] })
})
await waitFor(() => {
  assert.match(container.textContent ?? "", /Open a repository to get started/)
  assert.equal(container.querySelector('[role="alert"]'), null)
})
await act(async () => root.unmount())
client.clear()
await window.happyDOM.close()
