import { describe, expect, test } from "bun:test"

import { createUserWinningRestore } from "./pending-restore"

describe("createUserWinningRestore", () => {
  test("does not overwrite a user action with a pending restore", () => {
    const restore = createUserWinningRestore(true)
    let value = ""

    restore.userAction(() => {
      value = "user"
    })

    expect(
      restore.restore(() => {
        value = "stored"
      })
    ).toBe(false)
    expect(value).toBe("user")
  })

  test("applies a restore once when no user action intervenes", () => {
    const restore = createUserWinningRestore(true)
    let value = ""

    expect(
      restore.restore(() => {
        value = "stored"
      })
    ).toBe(true)
    expect(
      restore.restore(() => {
        value = "stale"
      })
    ).toBe(false)
    expect(value).toBe("stored")
  })

  test("starts completed when there is nothing to restore", () => {
    const restore = createUserWinningRestore(false)

    expect(restore.pending).toBe(false)
    expect(restore.restore(() => undefined)).toBe(false)
  })
})
