import { afterEach, describe, expect, test } from "bun:test"

import { getWorktreeStatusCache } from "./worktree-status-cache"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function status(path: string, changedFiles = 1) {
  return {
    path,
    branch: "main",
    head: "abc",
    isDetached: false,
    changedFiles,
    untrackedFiles: 0,
    pendingOperation: null,
  }
}

function fixture(path: string) {
  const worktree = {
    path,
    name: "main",
    branch: "main",
    head: "abc",
    isMain: true,
    isDetached: false,
    isLocked: false,
    isPrunable: false,
    isOpen: true,
  }
  return {
    project_snapshot: {
      id: path,
      name: path,
      path,
      worktrees: [
        worktree,
        { ...worktree, path: `${path}/gone`, isPrunable: true },
      ],
    },
    worktree_status: [status(path), status(`${path}/linked`, 2)],
    repository_state: {
      currentBranch: "main",
      defaultBranch: "main",
      headSha: "abc",
      isDetached: false,
      isDirty: true,
      pendingOperation: null,
      remote: "origin",
      remotes: ["origin"],
    },
    stash_list: [
      {
        base: "abc",
        branch: "main",
        date: "2026-01-01",
        message: "saved",
        name: "stash@{0}",
        sha: "def",
      },
    ],
  }
}

function transport(path: string) {
  const data = fixture(path)
  const requests: { command: string; args: Record<string, unknown> }[] = []
  let reply = (command: keyof typeof data) => Promise.resolve(data[command])
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const command = String(input).replace("/api/", "") as keyof typeof data
    requests.push({ command, args: JSON.parse(String(init?.body)) })
    return reply(command).then((value) => Response.json(value))
  }) as typeof fetch
  return {
    data,
    requests,
    setReply(next: typeof reply) {
      reply = next
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

describe("worktree status cache", () => {
  test("retains all four datasets across remounts and isolates repository paths", async () => {
    const path = "/cache/remount"
    const { data } = transport(path)
    const cache = getWorktreeStatusCache(path)
    expect(cache.getSnapshot()).toBe(cache.getSnapshot())
    let updates = 0
    const unsubscribe = cache.subscribe(() => updates++)
    await cache.refresh()
    unsubscribe()

    const remounted = getWorktreeStatusCache(path)
    expect(remounted).toBe(cache)
    expect(remounted.getSnapshot()).toEqual({
      projectWorktrees: [data.project_snapshot.worktrees[0]],
      worktreeStatuses: data.worktree_status,
      repository: data.repository_state,
      stashes: data.stash_list,
    })
    expect(updates).toBe(4)
    expect(getWorktreeStatusCache("/cache/other").getSnapshot()).toEqual({
      projectWorktrees: [],
      worktreeStatuses: [],
      repository: null,
      stashes: [],
    })
  })

  test("shares a full refresh after unmount and caches its eventual result", async () => {
    const path = "/cache/in-flight"
    const { data, requests, setReply } = transport(path)
    const pending = deferred<typeof data.worktree_status>()
    setReply((command) =>
      command === "worktree_status" ?
        pending.promise
      : Promise.resolve(data[command]),
    )
    const cache = getWorktreeStatusCache(path)
    let updates = 0
    const unsubscribe = cache.subscribe(() => updates++)
    const first = cache.refresh()
    unsubscribe()
    const remounted = getWorktreeStatusCache(path)
    expect(remounted.refresh()).toBe(first)
    expect(remounted.refresh("current")).toBe(first)
    expect(requests).toHaveLength(4)
    pending.resolve(data.worktree_status)
    await first
    expect(updates).toBe(0)
    expect(remounted.getSnapshot().worktreeStatuses).toEqual(
      data.worktree_status,
    )

    await remounted.refresh()
    expect(requests).toHaveLength(8)
  })

  test("reads all datasets after an operation completes during a passive refresh", async () => {
    const path = "/cache/after-operation"
    const { data, requests, setReply } = transport(path)
    const pending = deferred<typeof data.worktree_status>()
    setReply((command) =>
      command === "worktree_status" ?
        pending.promise
      : Promise.resolve(data[command]),
    )
    const cache = getWorktreeStatusCache(path)
    const passive = cache.refresh()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(cache.getSnapshot().repository?.currentBranch).toBe("main")
    data.project_snapshot.worktrees[0]!.branch = "feature"
    data.repository_state = {
      ...data.repository_state,
      currentBranch: "feature",
    }
    data.stash_list = []
    data.worktree_status = [{ ...status(path, 0), branch: "feature" }]
    setReply((command) => Promise.resolve(data[command]))
    const completed = cache.refresh("all", true)
    expect(completed).not.toBe(passive)
    expect(cache.refresh()).toBe(completed)
    expect(requests).toHaveLength(4)
    pending.resolve([status(path)])
    await completed
    expect(requests).toHaveLength(8)
    expect(cache.getSnapshot()).toEqual({
      projectWorktrees: [data.project_snapshot.worktrees[0]],
      worktreeStatuses: data.worktree_status,
      repository: data.repository_state,
      stashes: [],
    })
  })

  test("allows another repository to refresh while a full refresh is pending", async () => {
    const path = "/cache/independent-first"
    const { data, requests, setReply } = transport(path)
    const pending = deferred<typeof data.worktree_status>()
    setReply((command) =>
      command === "worktree_status" ?
        pending.promise
      : Promise.resolve(data[command]),
    )
    const first = getWorktreeStatusCache(path).refresh()
    setReply((command) => Promise.resolve(data[command]))
    const other = getWorktreeStatusCache("/cache/independent-second").refresh()
    expect(other).not.toBe(first)
    await other
    expect(
      requests.filter((request) => request.command === "worktree_status"),
    ).toHaveLength(2)
    expect(getWorktreeStatusCache(path).getSnapshot().worktreeStatuses).toEqual(
      [],
    )
    pending.resolve(data.worktree_status)
    await first
  })

  test("merges current-worktree results while retaining sibling statuses", async () => {
    const path = "/cache/current"
    const { data, requests } = transport(path)
    const cache = getWorktreeStatusCache(path)
    await cache.refresh()
    data.worktree_status = [status(path, 3)]
    const current = cache.refresh("current")
    expect(cache.refresh("current")).toBe(current)
    await current
    expect(cache.getSnapshot().worktreeStatuses).toEqual([
      status(path, 3),
      status(`${path}/linked`, 2),
    ])
    expect(
      requests.filter((request) => request.command === "worktree_status").at(-1)
        ?.args,
    ).toEqual({ repoPath: path, worktreePaths: [path] })
  })

  test("queues and shares a full refresh behind an existing current refresh", async () => {
    const path = "/cache/queued"
    const { data, requests, setReply } = transport(path)
    const pending = deferred<typeof data.worktree_status>()
    setReply((command) =>
      command === "worktree_status" ?
        pending.promise
      : Promise.resolve(data[command]),
    )
    const cache = getWorktreeStatusCache(path)
    const current = cache.refresh("current")
    const all = cache.refresh()
    expect(all).not.toBe(current)
    expect(cache.refresh()).toBe(all)
    expect(cache.refresh("current")).toBe(all)
    expect(requests).toHaveLength(4)
    setReply((command) => Promise.resolve(data[command]))
    pending.resolve([status(path, 3)])
    await current
    await all
    expect(requests).toHaveLength(8)
    expect(cache.getSnapshot().worktreeStatuses).toEqual(data.worktree_status)
  })

  test("retains cached data on failures and permits a later refresh", async () => {
    const path = "/cache/failure"
    const { data, setReply } = transport(path)
    const cache = getWorktreeStatusCache(path)
    await cache.refresh()
    const snapshot = cache.getSnapshot()
    setReply(() => Promise.reject(new Error("offline")))
    expect(await cache.refresh()).toBe(
      "Error: Could not reach the Git Nav server. Check that `git-nav serve` is running.",
    )
    expect(cache.getSnapshot()).toBe(snapshot)
    setReply((command) => Promise.resolve(data[command]))
    expect(await cache.refresh()).toBeNull()
  })
})
