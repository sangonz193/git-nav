import { observeElementRect, type Virtualizer } from "@tanstack/react-virtual"
import type { DockviewPanelApi } from "dockview-react"
import { useEffect, useRef, type RefObject } from "react"

// Dockview takes an inactive tab out of the document, where its scroller measures zero and would leave only
// the overscan rendered for the frame the tab comes back on. The size it had while in the document is the
// size it comes back to.
export function observeAttachedElementRect<
  TScrollElement extends Element,
  TItemElement extends Element,
>(
  instance: Virtualizer<TScrollElement, TItemElement>,
  cb: (rect: { width: number; height: number }) => void,
) {
  return observeElementRect(instance, (rect) => {
    if (instance.scrollElement?.isConnected) {
      cb(rect)
    }
  })
}

// Leaving the document also resets the scroll offset, so it is put back as soon as dockview reattaches the
// tab, before the frame paints. The saved offset stands in for the element's own while the tab is away.
export function useTabScrollTop(
  api: DockviewPanelApi,
  scrollElement: RefObject<HTMLElement | null>,
) {
  const savedScrollTop = useRef(0)
  useEffect(() => {
    const element = scrollElement.current
    if (!element) {
      return
    }
    const onScroll = () => {
      savedScrollTop.current = element.scrollTop
    }
    element.addEventListener("scroll", onScroll, { passive: true })
    const visibility = api.onDidVisibilityChange(({ isVisible }) => {
      if (isVisible) {
        element.scrollTop = savedScrollTop.current
      }
    })
    return () => {
      element.removeEventListener("scroll", onScroll)
      visibility.dispose()
    }
  }, [api, scrollElement])
  return savedScrollTop
}
