import { describe, expect, test } from "bun:test"

import {
  closesTab,
  desktopAppShortcut,
  reopensTab,
  repositoryShortcutIndex,
  togglesSidebar,
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
    false,
  )
}

describe("desktop app shortcuts", () => {
  test("maps navigation and zoom commands", () => {
    expect(shortcut("n")).toBe("new-window")
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
        true,
      ),
    ).toBeNull()
    expect(
      usesNativeMenu("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"),
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

describe("repository shortcuts", () => {
  const key = (key: string, overrides: Partial<KeyboardEvent> = {}) => ({
    altKey: false,
    code: "",
    ctrlKey: false,
    key,
    metaKey: true,
    shiftKey: false,
    ...overrides,
  })

  test("pick a repository by position, with 9 for the last", () => {
    expect(repositoryShortcutIndex(key("1"), true, 3)).toBe(0)
    expect(repositoryShortcutIndex(key("3"), true, 3)).toBe(2)
    expect(repositoryShortcutIndex(key("4"), true, 3)).toBeNull()
    expect(repositoryShortcutIndex(key("9"), true, 3)).toBe(2)
    expect(repositoryShortcutIndex(key("9"), true, 0)).toBeNull()
  })

  test("use Command on macOS and Ctrl elsewhere", () => {
    expect(repositoryShortcutIndex(key("1"), false, 3)).toBeNull()
    expect(
      repositoryShortcutIndex(
        key("1", { ctrlKey: true, metaKey: false }),
        false,
        3,
      ),
    ).toBe(0)
    expect(repositoryShortcutIndex(key("1", { shiftKey: true }), true, 3)).toBe(
      0,
    )
  })

  test("accept physical digit keys on layouts with shifted digits", () => {
    for (let digit = 1; digit <= 9; digit++) {
      const index = digit === 9 ? 9 : digit - 1
      for (const shiftKey of [false, true]) {
        expect(
          repositoryShortcutIndex(
            key("&", { code: `Digit${digit}`, shiftKey }),
            true,
            10,
          ),
        ).toBe(index)
        expect(
          repositoryShortcutIndex(
            key("&", {
              code: `Digit${digit}`,
              ctrlKey: true,
              metaKey: false,
              shiftKey,
            }),
            false,
            10,
          ),
        ).toBe(index)
      }
    }
    expect(
      repositoryShortcutIndex(key("&", { code: "Digit4" }), true, 3),
    ).toBeNull()
    expect(
      repositoryShortcutIndex(key("&", { code: "Digit9" }), true, 0),
    ).toBeNull()
  })

  test("reject other physical keys and conflicting modifiers", () => {
    for (const code of ["Digit0", "Numpad1", "KeyA", ""]) {
      expect(repositoryShortcutIndex(key("&", { code }), true, 3)).toBeNull()
    }
    for (const overrides of [
      { altKey: true },
      { metaKey: false },
      { ctrlKey: true },
    ]) {
      expect(
        repositoryShortcutIndex(
          key("&", { code: "Digit1", ...overrides }),
          true,
          3,
        ),
      ).toBeNull()
    }
  })
})

describe("sidebar shortcut", () => {
  const key = (overrides: Partial<KeyboardEvent>) => ({
    altKey: false,
    ctrlKey: false,
    key: "b",
    metaKey: false,
    shiftKey: false,
    ...overrides,
  })

  test("uses Command on macOS and Ctrl elsewhere", () => {
    expect(togglesSidebar(key({ metaKey: true }), true)).toBeTrue()
    expect(togglesSidebar(key({ ctrlKey: true }), true)).toBeFalse()
    expect(togglesSidebar(key({ ctrlKey: true }), false)).toBeTrue()
    expect(
      togglesSidebar(key({ metaKey: true, shiftKey: true }), true),
    ).toBeFalse()
  })
})
