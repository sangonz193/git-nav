import { describe, expect, test } from "bun:test"
import type { Virtualizer } from "@tanstack/react-virtual"

import { observeAttachedElementRect } from "./tab-scroll"

function virtualizerOver(isConnected: boolean, height: number) {
  return {
    options: { useAnimationFrameWithResizeObserver: false },
    scrollElement: { isConnected, offsetHeight: height, offsetWidth: 400 },
    targetWindow: {},
  } as unknown as Virtualizer<Element, Element>
}

describe("observeAttachedElementRect", () => {
  test("reports the size of a scroller in the document", () => {
    const rects: { width: number; height: number }[] = []
    observeAttachedElementRect(virtualizerOver(true, 600), (rect) =>
      rects.push(rect),
    )
    expect(rects).toEqual([{ width: 400, height: 600 }])
  })

  test("keeps the last size while the scroller is out of the document", () => {
    const rects: { width: number; height: number }[] = []
    observeAttachedElementRect(virtualizerOver(false, 0), (rect) =>
      rects.push(rect),
    )
    expect(rects).toEqual([])
  })
})
