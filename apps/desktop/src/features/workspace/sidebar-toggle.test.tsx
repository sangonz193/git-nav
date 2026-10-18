import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import { TooltipProvider } from "@workspace/shadcn/components/tooltip"
import { ShowSidebarControls } from "./sidebar-toggle"
import { SidebarToggleContext } from "./sidebar-toggle-context"

describe("hidden sidebar controls", () => {
  test("shows the toggle before the application menu", () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <SidebarToggleContext.Provider value={{ collapsed: true, toggle() {} }}>
          <ShowSidebarControls className="mr-1" />
        </SidebarToggleContext.Provider>
      </TooltipProvider>,
    )

    const toggle = markup.indexOf('aria-label="Show sidebar"')
    const menu = markup.indexOf('aria-label="Application menu"')
    expect(toggle).toBeGreaterThan(-1)
    expect(menu).toBeGreaterThan(toggle)
    expect(markup).toContain('class="flex items-center gap-0.5 mr-1"')
  })

  test("leaves controls in the sidebar when it is visible", () => {
    expect(
      renderToStaticMarkup(
        <SidebarToggleContext.Provider
          value={{ collapsed: false, toggle() {} }}
        >
          <ShowSidebarControls />
        </SidebarToggleContext.Provider>,
      ),
    ).toBe("")
  })

  test("renders nothing outside a workspace", () => {
    expect(renderToStaticMarkup(<ShowSidebarControls />)).toBe("")
  })
})
