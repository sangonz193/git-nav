import { Hinted } from "@/components/hinted"
import { Button } from "@workspace/shadcn/components/button"
import { ButtonGroup } from "@workspace/shadcn/components/button-group"
import { Switch } from "@workspace/shadcn/components/switch"
import { cn } from "@workspace/shadcn/lib/utils"
import { FoldVertical, UnfoldVertical, type LucideIcon } from "lucide-react"
import type { ReactNode } from "react"

export function PanelSection({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <section
      className={cn(
        "flex flex-col gap-1 p-2 text-sm not-first:border-t",
        className,
      )}
    >
      {children}
    </section>
  )
}

export function PanelHeading({
  action,
  children,
}: {
  action?: ReactNode
  children: string
}) {
  return (
    <div className="flex h-5 items-center justify-between">
      <div className="px-1.5 text-xs font-medium text-muted-foreground">
        {children}
      </div>
      {action}
    </div>
  )
}

export function SwitchRow({
  checked,
  icon: Icon,
  id,
  label,
  onCheckedChange,
}: {
  checked: boolean
  icon?: LucideIcon
  id: string
  label: string
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <label
      className="flex h-7 cursor-pointer items-center gap-2 rounded-md px-1.5 hover:bg-muted"
      htmlFor={id}
    >
      {Icon && <Icon className="size-3.5 text-muted-foreground" />}
      <span className="flex-1">{label}</span>
      <Switch checked={checked} id={id} onCheckedChange={onCheckedChange} />
    </label>
  )
}

export function LabeledRow({
  children,
  hint,
  label,
}: {
  children: ReactNode
  hint?: string | null
  label: string
}) {
  const row = (
    <div className="flex h-7 items-center justify-between gap-2 px-1.5">
      <span className={cn(hint && "text-muted-foreground")}>{label}</span>
      {children}
    </div>
  )
  return hint ? <Hinted hint={hint}>{row}</Hinted> : row
}

export function Segmented<T extends string>({
  disabled = false,
  onChange,
  options,
  value,
}: {
  disabled?: boolean
  onChange: (value: T) => void
  options: { icon?: LucideIcon; label: string; value: T }[]
  value: T
}) {
  return (
    <ButtonGroup role="radiogroup">
      {options.map(({ icon: Icon, label, value: option }) => (
        <Button
          aria-checked={option === value}
          aria-pressed={option === value}
          disabled={disabled}
          key={option}
          onClick={() => onChange(option)}
          role="radio"
          size="xs"
          type="button"
          variant="outline"
        >
          {Icon && <Icon />}
          {label}
        </Button>
      ))}
    </ButtonGroup>
  )
}

// A pair rather than a toggle: each side names what it does, and reads as pressed only while everything
// already sits that way, so a mixed state leaves both open.
export function FoldButtons({
  allCollapsed,
  allExpanded,
  collapseHint,
  disabled = false,
  expandHint,
  onCollapse,
  onExpand,
  size = "icon-sm",
}: {
  allCollapsed: boolean
  allExpanded: boolean
  collapseHint: string
  disabled?: boolean
  expandHint: string
  onCollapse: () => void
  onExpand: () => void
  size?: "icon-sm" | "icon-xs"
}) {
  return (
    <ButtonGroup>
      <Hinted hint={collapseHint}>
        <Button
          aria-label={collapseHint}
          aria-pressed={allCollapsed}
          disabled={disabled}
          onClick={onCollapse}
          size={size}
          type="button"
          variant="outline"
        >
          <FoldVertical />
        </Button>
      </Hinted>
      <Hinted hint={expandHint}>
        <Button
          aria-label={expandHint}
          aria-pressed={allExpanded}
          disabled={disabled}
          onClick={onExpand}
          size={size}
          type="button"
          variant="outline"
        >
          <UnfoldVertical />
        </Button>
      </Hinted>
    </ButtonGroup>
  )
}
