import { describe, expect, test } from "bun:test"

import { settingsClientId } from "./settings"

describe("settings client", () => {
  test("uses one namespace for every desktop window", () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("unused")
      },
    }
    expect(settingsClientId(true, storage, () => "browser-id")).toBe("desktop")
  })

  test("generates and persists a separate browser namespace", () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
    }
    expect(settingsClientId(false, storage, () => "browser-a")).toBe(
      "browser-a"
    )
    expect(settingsClientId(false, storage, () => "browser-b")).toBe(
      "browser-a"
    )
    const otherValues = new Map<string, string>()
    const otherStorage = {
      getItem: (key: string) => otherValues.get(key) ?? null,
      setItem: (key: string, value: string) => {
        otherValues.set(key, value)
      },
    }
    expect(settingsClientId(false, otherStorage, () => "browser-b")).toBe(
      "browser-b"
    )
  })
})
