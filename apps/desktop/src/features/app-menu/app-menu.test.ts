import { describe, expect, test } from "bun:test"

import {
  closesTab,
  desktopAppShortcut,
  reopensTab,
  usesNativeMenu,
} from "./app-menu-shortcuts"

function shortcut(key: string, overrides: Partial<KeyboardEvent> = {}) {
  return desktopAppShortcut(
    {
      altKey: false,
      ctrlKey: true,
      key,
      metaKey: false,
      shiftKey: false,
      ...overrides,
    },
    false
  )
}

describe("desktop app shortcuts", () => {
  test("maps navigation and zoom commands", () => {
    expect(shortcut("n")).toBe("show-launcher")
    expect(shortcut("o")).toBe("choose-repository")
    expect(shortcut("=")).toBe("zoom-in")
    expect(shortcut("-")).toBe("zoom-out")
    expect(shortcut("0")).toBe("actual-size")
  })

  test("allows Shift only for zoom-in", () => {
    expect(shortcut("+", { shiftKey: true })).toBe("zoom-in")
    expect(shortcut("+")).toBe("zoom-in")
    expect(shortcut("-")).toBe("zoom-out")
    expect(shortcut("-", { shiftKey: true })).toBeNull()
    expect(shortcut("0", { shiftKey: true })).toBeNull()
  })

  test("leaves shortcuts to the macOS native menu", () => {
    expect(
      desktopAppShortcut(
        {
          altKey: false,
          ctrlKey: true,
          key: "n",
          metaKey: false,
          shiftKey: false,
        },
        true
      )
    ).toBeNull()
    expect(
      usesNativeMenu("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")
    ).toBeTrue()
    expect(usesNativeMenu("Mozilla/5.0 (X11; Linux x86_64)")).toBeFalse()
  })

  test("closes a tab only where the native menu does not", () => {
    const event = {
      altKey: false,
      ctrlKey: true,
      key: "w",
      metaKey: false,
      shiftKey: false,
    }
    expect(closesTab(event, false)).toBeTrue()
    expect(closesTab({ ...event, key: "W" }, false)).toBeTrue()
    expect(closesTab(event, true)).toBeFalse()
    expect(closesTab({ ...event, shiftKey: true }, false)).toBeFalse()
    expect(closesTab({ ...event, ctrlKey: false }, false)).toBeFalse()
    expect(closesTab({ ...event, metaKey: true }, false)).toBeFalse()
    expect(closesTab({ ...event, key: "q" }, false)).toBeFalse()
    expect(shortcut("w")).toBeNull()
  })

  test("reopens a tab only where the native menu does not", () => {
    const event = {
      altKey: false,
      ctrlKey: true,
      key: "t",
      metaKey: false,
      shiftKey: true,
    }
    expect(reopensTab(event, false)).toBeTrue()
    expect(reopensTab({ ...event, key: "T" }, false)).toBeTrue()
    expect(reopensTab(event, true)).toBeFalse()
    expect(reopensTab({ ...event, shiftKey: false }, false)).toBeFalse()
    expect(reopensTab({ ...event, ctrlKey: false }, false)).toBeFalse()
    expect(reopensTab({ ...event, metaKey: true }, false)).toBeFalse()
    expect(reopensTab({ ...event, key: "w" }, false)).toBeFalse()
    expect(closesTab(event, false)).toBeFalse()
  })

  test("ignores unmodified and alternate shortcuts", () => {
    expect(shortcut("n", { ctrlKey: false })).toBeNull()
    expect(shortcut("n", { altKey: true })).toBeNull()
    expect(shortcut("n", { metaKey: true })).toBeNull()
    expect(shortcut("N", { shiftKey: true })).toBeNull()
    expect(shortcut("O", { shiftKey: true })).toBeNull()
    expect(shortcut("p")).toBeNull()
  })
})
