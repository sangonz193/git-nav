import { describe, expect, test } from "bun:test"

import { repositoryHeaderControls } from "./header-controls"

describe("repository header controls", () => {
  test("renders app-global controls only in the active group", () => {
    expect(
      repositoryHeaderControls({
        desktop: true,
        isGroupActive: true,
        location: { type: "grid" },
      })
    ).toEqual({ appMenu: true, sharingIndicator: true })
    expect(
      repositoryHeaderControls({
        desktop: true,
        isGroupActive: false,
        location: { type: "grid" },
      })
    ).toEqual({ appMenu: false, sharingIndicator: false })
  })

  test("keeps the sharing indicator in an active floating group without the app menu", () => {
    expect(
      repositoryHeaderControls({
        desktop: true,
        isGroupActive: true,
        location: { type: "floating" },
      })
    ).toEqual({ appMenu: false, sharingIndicator: true })
  })

  test("shows the app menu when the group has no location", () => {
    expect(
      repositoryHeaderControls({ desktop: true, isGroupActive: true })
    ).toEqual({ appMenu: true, sharingIndicator: true })
  })

  test("never shows the sharing indicator in the browser", () => {
    expect(
      repositoryHeaderControls({
        desktop: false,
        isGroupActive: true,
        location: { type: "grid" },
      })
    ).toEqual({ appMenu: true, sharingIndicator: false })
  })
})
