export type SheetDrag = {
  height: number
  moved: boolean
  towardsOpen: boolean
}

const SNAP_ON_THE_WAY = 0.15

export function snapExpanded(
  drag: SheetDrag,
  maxBodyHeight: number,
  expanded: boolean,
) {
  if (!drag.moved) {
    return !expanded
  }
  const limit = Math.max(1, maxBodyHeight)
  return drag.towardsOpen ?
      drag.height > limit * SNAP_ON_THE_WAY
    : drag.height >= limit * (1 - SNAP_ON_THE_WAY)
}
