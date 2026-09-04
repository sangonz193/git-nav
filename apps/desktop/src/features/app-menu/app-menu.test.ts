import { describe, expect, test } from "bun:test"

import { desktopAppShortcut, usesNativeMenu } from "./app-menu-shortcuts"

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

  test("ignores unmodified and alternate shortcuts", () => {
    expect(shortcut("n", { ctrlKey: false })).toBeNull()
    expect(shortcut("n", { altKey: true })).toBeNull()
    expect(shortcut("n", { metaKey: true })).toBeNull()
    expect(shortcut("N", { shiftKey: true })).toBeNull()
    expect(shortcut("O", { shiftKey: true })).toBeNull()
    expect(shortcut("p")).toBeNull()
  })
})
