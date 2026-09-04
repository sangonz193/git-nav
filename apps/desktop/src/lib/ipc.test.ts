import { afterEach, describe, expect, test } from "bun:test"

import { invoke } from "./ipc"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("invoke", () => {
  test("starts a keepalive HTTP request before returning", async () => {
    const requests: [string | URL | Request, RequestInit | undefined][] = []
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      requests.push([input, init])
      return Promise.resolve(
        new Response("null", {
          headers: { "Content-Type": "application/json" },
        })
      )
    }) as typeof fetch

    const saving = invoke(
      "save_repository_layout",
      { path: "/repo" },
      { keepalive: true }
    )

    expect(requests).toHaveLength(1)
    expect(requests[0][0]).toBe("/api/save_repository_layout")
    expect(requests[0][1]?.keepalive).toBe(true)
    await saving
  })
})
