import assert from "node:assert/strict"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { mockIPC } from "@tauri-apps/api/mocks"
import { renderToStaticMarkup } from "react-dom/server"

const desktop = process.argv[2] === "desktop"
const requests: { command: string; args: unknown }[] = []
Object.defineProperty(globalThis, "window", {
  value: { location: { search: "" } },
})
Object.defineProperty(globalThis, "sessionStorage", {
  value: { getItem: () => null },
})
if (desktop) {
  mockIPC((command, args) => {
    requests.push({ command, args })
  })
} else {
  globalThis.fetch = Object.assign(
    () => {
      throw new Error("Selecting a worktree in a browser must stay local")
    },
    { preconnect: globalThis.fetch.preconnect },
  )
}

const { useWorkspace } = await import("../use-workspace")
let workspace: ReturnType<typeof useWorkspace> | undefined
let flushes = 0
const layoutFlush = {
  current: async () => {
    flushes++
  },
}
export function Harness({
  capture,
}: {
  capture: (value: ReturnType<typeof useWorkspace>) => void
}) {
  capture(useWorkspace(layoutFlush))
  return null
}

renderToStaticMarkup(
  <QueryClientProvider client={new QueryClient()}>
    <Harness capture={(value) => (workspace = value)} />
  </QueryClientProvider>,
)
assert.ok(workspace)

await workspace.show({ project: "/code/app/.git", worktree: "/code/app-fix" })
if (desktop) {
  assert.deepEqual(requests, [
    { command: "open_repository", args: { path: "/code/app-fix" } },
  ])
  assert.equal(flushes, 0)
} else {
  assert.deepEqual(requests, [])
  assert.equal(flushes, 1)
}

await workspace.show(null)
assert.equal(flushes, desktop ? 1 : 2)
assert.equal(requests.length, desktop ? 1 : 0)

if (desktop) {
  await workspace.openInNewWindow({
    project: "/code/app/.git",
    worktree: "/code/app-fix",
  })
  assert.deepEqual(requests.at(-1), {
    command: "open_repository_in_new_window",
    args: { path: "/code/app-fix" },
  })
}
