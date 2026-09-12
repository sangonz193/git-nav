import { describe, expect, test } from "bun:test"

import { tabsToClose } from "./tab-closing"

const panels = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]
const ids = (closed: { id: string }[]) => closed.map((panel) => panel.id)

describe("tabs to close", () => {
  test("others keeps only the chosen tab", () => {
    expect(ids(tabsToClose(panels, "b", "others"))).toEqual(["a", "c", "d"])
  })

  test("left closes the tabs before the chosen one", () => {
    expect(ids(tabsToClose(panels, "c", "left"))).toEqual(["a", "b"])
    expect(ids(tabsToClose(panels, "a", "left"))).toEqual([])
  })

  test("right closes the tabs after the chosen one", () => {
    expect(ids(tabsToClose(panels, "b", "right"))).toEqual(["c", "d"])
    expect(ids(tabsToClose(panels, "d", "right"))).toEqual([])
  })

  test("all closes every tab", () => {
    expect(ids(tabsToClose(panels, "b", "all"))).toEqual(["a", "b", "c", "d"])
  })

  test("a tab that is no longer in the group closes nothing around it", () => {
    expect(ids(tabsToClose(panels, "missing", "left"))).toEqual([])
    expect(ids(tabsToClose(panels, "missing", "right"))).toEqual([])
  })
})
