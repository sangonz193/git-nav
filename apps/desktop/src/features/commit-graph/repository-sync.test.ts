import { describe, expect, test } from "bun:test"

import {
  autoFetchSetting,
  completedKinds,
  type SyncStatus,
} from "./repository-sync"

test("auto-fetch settings are scoped to the shared repository ID", () => {
  expect(autoFetchSetting("/first/.git")).toBe("sync.autoFetch:/first/.git")
  expect(autoFetchSetting("/first/.git")).not.toBe(
    autoFetchSetting("/second/.git"),
  )
})

function status(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    projectId: "project",
    autoFetch: true,
    fetch: {
      isRunning: false,
      completedAt: null,
      succeededAt: null,
      error: null,
    },
    pullRequests: {
      isRunning: false,
      completedAt: null,
      succeededAt: null,
      error: null,
    },
    ...overrides,
  }
}

describe("completedKinds", () => {
  test("reports nothing when no run has finished yet", () => {
    expect(completedKinds(null, status())).toEqual([])
  })

  test("reports the first reading of a finished run", () => {
    const next = status({
      pullRequests: {
        isRunning: false,
        completedAt: 10,
        succeededAt: 10,
        error: null,
      },
    })

    expect(completedKinds(null, next)).toEqual(["pullRequests"])
  })

  test("reports only the kinds whose run finished since the last reading", () => {
    const previous = status({
      fetch: { isRunning: false, completedAt: 5, succeededAt: 5, error: null },
      pullRequests: {
        isRunning: false,
        completedAt: 10,
        succeededAt: 10,
        error: null,
      },
    })
    const next = status({
      fetch: { isRunning: false, completedAt: 5, succeededAt: 5, error: null },
      pullRequests: {
        isRunning: false,
        completedAt: 20,
        succeededAt: 10,
        error: "offline",
      },
    })

    expect(completedKinds(previous, next)).toEqual(["pullRequests"])
  })

  test("ignores a run that is still going", () => {
    const previous = status({
      fetch: { isRunning: false, completedAt: 5, succeededAt: 5, error: null },
    })
    const next = status({
      fetch: { isRunning: true, completedAt: 5, succeededAt: 5, error: null },
    })

    expect(completedKinds(previous, next)).toEqual([])
  })
})
