import { afterEach, describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  sidebarKeyboardWidth,
  useSidebar,
} from "./use-sidebar"

const storageDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
)

afterEach(() => {
  if (storageDescriptor) {
    Object.defineProperty(globalThis, "localStorage", storageDescriptor)
  } else {
    Reflect.deleteProperty(globalThis, "localStorage")
  }
})

function SidebarState() {
  const { collapsed, width } = useSidebar()
  return <div data-collapsed={collapsed} data-width={width} />
}

function storedSidebar(width: string | null, collapsed = "false") {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) =>
        key.endsWith("sidebar-width") ? width : collapsed,
    },
  })
  return renderToStaticMarkup(<SidebarState />)
}

describe("sidebar storage", () => {
  test("uses defaults when accessing storage is blocked", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("Storage blocked")
      },
    })
    const markup = renderToStaticMarkup(<SidebarState />)
    expect(markup).toContain(`data-width="${SIDEBAR_DEFAULT_WIDTH}"`)
    expect(markup).toContain('data-collapsed="false"')
  })

  test("uses defaults when reading storage is blocked", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem() {
          throw new Error("Storage blocked")
        },
      },
    })
    const markup = renderToStaticMarkup(<SidebarState />)
    expect(markup).toContain(`data-width="${SIDEBAR_DEFAULT_WIDTH}"`)
    expect(markup).toContain('data-collapsed="false"')
  })

  test("restores and clamps stored widths", () => {
    expect(storedSidebar("320", "true")).toContain('data-width="320"')
    expect(storedSidebar("320", "true")).toContain('data-collapsed="true"')
    expect(storedSidebar("100")).toContain(`data-width="${SIDEBAR_MIN_WIDTH}"`)
    expect(storedSidebar("900")).toContain(`data-width="${SIDEBAR_MAX_WIDTH}"`)
    for (const width of [null, "0", "-1", "invalid"]) {
      expect(storedSidebar(width)).toContain(
        `data-width="${SIDEBAR_DEFAULT_WIDTH}"`,
      )
    }
  })
})

describe("sidebar handle keyboard", () => {
  test("leaves a hidden sidebar hidden on ArrowLeft", () => {
    expect(sidebarKeyboardWidth("ArrowLeft", true, 240)).toBeNull()
    expect(sidebarKeyboardWidth("ArrowRight", true, 240)).toBe(
      SIDEBAR_MIN_WIDTH,
    )
  })

  test("resizes a visible sidebar and leaves other keys alone", () => {
    expect(sidebarKeyboardWidth("ArrowLeft", false, 240)).toBe(224)
    expect(sidebarKeyboardWidth("ArrowRight", false, 240)).toBe(256)
    expect(sidebarKeyboardWidth("ArrowLeft", false, SIDEBAR_MIN_WIDTH)).toBe(
      SIDEBAR_MIN_WIDTH,
    )
    expect(sidebarKeyboardWidth("Enter", false, 240)).toBeNull()
  })
})
