import { Search, X } from "lucide-react"
import { type ComponentType, type KeyboardEvent as ReactKeyboardEvent, type RefObject, useEffect, useRef } from "react"

import { Button } from "@workspace/shadcn/components/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@workspace/shadcn/components/tooltip"

type Icon = ComponentType<{ className?: string }>

export type SearchMenuItem = {
  /** A second thing the row can do, offered beside it rather than instead of selecting the row. */
  action?: { hint: string; icon: Icon; onSelect: () => void }
  detail: string
  icon: Icon
  key: string
  label: string
}

export function SearchMenu({
  activeIndex,
  emptyMessage = "No matches",
  inputLabel,
  inputRef,
  items,
  onClose,
  onHighlight,
  onQueryChange,
  onSelect,
  placeholder,
  query,
}: {
  activeIndex: number
  emptyMessage?: string
  inputLabel: string
  inputRef?: RefObject<HTMLInputElement | null>
  items: SearchMenuItem[]
  onClose: () => void
  onHighlight: (index: number) => void
  onQueryChange: (query: string) => void
  onSelect: (index: number, source: "click" | "enter") => void
  placeholder: string
  query: string
}) {
  const fallbackRef = useRef<HTMLInputElement>(null)
  const field = inputRef ?? fallbackRef

  useEffect(() => {
    field.current?.select()
  }, [field])

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      // Whatever the menu sits in has its own meaning for Escape, which is not what closing it asks for.
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      if (items.length === 0) {
        return
      }
      onHighlight((activeIndex + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length)
      return
    }
    if (event.key === "Enter" && items[activeIndex]) {
      event.preventDefault()
      onSelect(activeIndex, "enter")
    }
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-popover shadow-(--overlay-shadow)">
      <div className="flex items-center gap-1 border-b px-2 py-1">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          aria-label={inputLabel}
          className="h-7 min-w-0 flex-1 bg-transparent text-sm outline-none"
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          ref={field}
          value={query}
        />
        {items.length > 0 && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{`${activeIndex + 1}/${items.length}`}</span>}
        <Button aria-label="Close search" onClick={onClose} size="icon-xs" type="button" variant="ghost">
          <X />
        </Button>
      </div>
      <ul className="max-h-64 overflow-y-auto p-1">
        {items.map((item, index) => (
          <li className="flex items-center gap-1" key={item.key}>
            <button
              className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left ${index === activeIndex ? "bg-accent text-accent-foreground" : ""}`}
              onClick={() => onSelect(index, "click")}
              type="button"
            >
              <item.icon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{item.label}</span>
                <span className="block truncate text-xs text-muted-foreground">{item.detail}</span>
              </span>
            </button>
            {item.action && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button aria-label={item.action.hint} onClick={item.action.onSelect} size="icon-xs" type="button" variant="ghost">
                    <item.action.icon />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{item.action.hint}</TooltipContent>
              </Tooltip>
            )}
          </li>
        ))}
        {query.trim() !== "" && items.length === 0 && <li className="px-2 py-1 text-sm text-muted-foreground">{emptyMessage}</li>}
      </ul>
    </div>
  )
}
