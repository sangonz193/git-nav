import { describe, expect, test } from "bun:test"

import {
  dockTitleBarGroups,
  initialMacOSFullscreen,
  usesMacOSWindowChrome,
  type DockGroupGeometry,
} from "./macos-window-chrome"

function group(
  id: string,
  left: number,
  top: number,
  location: DockGroupGeometry["location"] = "grid"
) {
  return { id, left, location, top }
}

describe("macOS window chrome", () => {
  test("only enables desktop windows on macOS", () => {
    const macOS = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
    expect(usesMacOSWindowChrome(true, macOS)).toBeTrue()
    expect(usesMacOSWindowChrome(false, macOS)).toBeFalse()
    expect(
      usesMacOSWindowChrome(true, "Mozilla/5.0 (X11; Linux x86_64)")
    ).toBeFalse()
  })

  test("starts with the native fullscreen state", () => {
    expect(initialMacOSFullscreen(true, false)).toBeFalse()
    expect(initialMacOSFullscreen(true, true)).toBeTrue()
    expect(initialMacOSFullscreen(false, true)).toBeFalse()
  })

  test("reserves traffic-light space in the top-left group", () => {
    const result = dockTitleBarGroups(
      { top: 0 },
      [group("right", 640, 0), group("left", 0, 0)]
    )

    expect([...result.titleBarGroupIds]).toEqual(["right", "left"])
    expect(result.trafficLightGroupId).toBe("left")
  })

  test("follows the leftmost group after groups move or close", () => {
    const root = { top: 0 }
    expect(
      dockTitleBarGroups(
        root,
        [group("first", 500, 0), group("second", 0, 0)]
      ).trafficLightGroupId
    ).toBe("second")
    expect(
      dockTitleBarGroups(root, [group("first", 0, 0)])
        .trafficLightGroupId
    ).toBe("first")
  })

  test("does not turn lower, floating, popout, or edge strips into title bars", () => {
    const result = dockTitleBarGroups(
      { top: 12 },
      [
        group("top", 8, 12),
        group("lower", 8, 400),
        group("floating", 20, 12, "floating"),
        group("popout", 0, 12, "popout"),
        group("edge", 0, 12, "edge"),
      ]
    )

    expect([...result.titleBarGroupIds]).toEqual(["top"])
    expect(result.trafficLightGroupId).toBe("top")
  })
})
