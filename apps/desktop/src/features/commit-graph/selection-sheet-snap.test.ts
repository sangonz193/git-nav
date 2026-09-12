import { describe, expect, test } from "bun:test"

import { snapExpanded } from "./selection-sheet-snap"

describe("snapExpanded", () => {
  test("toggles after a click without movement", () => {
    expect(
      snapExpanded({ height: 0, moved: false, towardsOpen: true }, 100, false),
    ).toBe(true)
    expect(
      snapExpanded(
        { height: 100, moved: false, towardsOpen: false },
        100,
        true,
      ),
    ).toBe(false)
  })

  test("opens after moving up two pixels then down one from closed", () => {
    expect(
      snapExpanded({ height: 0, moved: false, towardsOpen: false }, 100, false),
    ).toBe(true)
  })

  test("closes after moving down one pixel then up one from open", () => {
    expect(
      snapExpanded({ height: 100, moved: false, towardsOpen: true }, 100, true),
    ).toBe(false)
  })

  test("keeps a short upward drag from closed collapsed", () => {
    expect(
      snapExpanded({ height: 15, moved: true, towardsOpen: true }, 100, false),
    ).toBe(false)
  })

  test("opens after an upward drag passes the threshold", () => {
    expect(
      snapExpanded({ height: 16, moved: true, towardsOpen: true }, 100, false),
    ).toBe(true)
  })

  test("keeps a short downward drag from open expanded", () => {
    expect(
      snapExpanded({ height: 85, moved: true, towardsOpen: false }, 100, true),
    ).toBe(true)
  })

  test("closes after a downward drag passes the threshold", () => {
    expect(
      snapExpanded({ height: 84, moved: true, towardsOpen: false }, 100, true),
    ).toBe(false)
  })
})
