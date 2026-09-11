import { useMutation } from "@tanstack/react-query"
import { invoke } from "@/lib/ipc"
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@workspace/shadcn/components/alert-dialog"
import { Button } from "@workspace/shadcn/components/button"
import { TriangleAlert } from "lucide-react"
import { Fragment, useEffect, useMemo, useState } from "react"

import { splitRefLabel, type Selection } from "./commit-graph"
import { applicableOperations, CHIP_ICONS, flag, OPERATION_GROUPS, operationById, operationTitle, predictConflicts, resolveFields, selectionLabel, type BranchOperationState, type CompletedOperation, type Label, type NameKind, type Operand, type OperationGroup, type OperationRequest, type OperationResult, type OperationState, type Plan, type Values, type RefMenuComponents, type RepositoryState } from "./commit-operations"

const PREDICTION_DEBOUNCE = 200

// A ref name is told apart by its tail, so the tail stays put and the middle gives way. A name with a kind is
// boxed with its icon the way the graph chips are, so the two read as one thing inside a sentence.
export function RefName({ kind, name }: { kind?: NameKind, name: string }) {
  const { start, end } = kind === "worktree" || kind === "stash" ? { start: name, end: "" } : splitRefLabel(name)
  const Icon = kind && CHIP_ICONS[kind]
  return (
    <span className={`flex min-w-0 items-center${Icon ? " rounded-sm bg-foreground/10 px-1 [&_svg]:size-3!" : ""}`}>
      {Icon && <Icon className="mr-1" />}
      <span className="min-w-0 truncate whitespace-pre">{start}</span>
      {end && <span className="shrink-0 whitespace-pre">{end}</span>}
    </span>
  )
}

export function LabelText({ label }: { label: Label }) {
  if (typeof label === "string") {
    return <span className="min-w-0 truncate">{label}</span>
  }
  return (
    <span className="flex min-w-0">
      {label.before && <span className="shrink-0 whitespace-pre">{label.before}</span>}
      <RefName kind={label.kind} name={label.name} />
      {label.after && <span className="shrink-0 whitespace-pre">{label.after}</span>}
    </span>
  )
}

// The separator goes on the side that faces the rest of the menu, so a slot at the bottom does not end in one.
export function OperationMenuItems({ components, groups = OPERATION_GROUPS, onSelect, repository, separator = "after", source, target }: {
  components: RefMenuComponents
  groups?: readonly OperationGroup[]
  onSelect: (request: OperationRequest) => void
  repository: RepositoryState | null
  separator?: "after" | "before"
  source: Selection | null
  target: Operand
}) {
  const { Item, Label, Separator } = components
  if (!repository) {
    return null
  }
  const entries = applicableOperations(repository, source, target).filter(({ operation }) => groups.includes(operation.group))
  if (entries.length === 0) {
    return null
  }
  return (
    <>
      {separator === "before" && <Separator />}
      {entries.map(({ operation, request, unavailable }, index) => {
        const Icon = operation.icon
        const opensGroup = entries[index - 1]?.operation.group !== operation.group
        return (
          <Fragment key={operation.id}>
            {index > 0 && opensGroup && <Separator />}
            {opensGroup && operation.group === "selection" && source && (
              <Label>
                <span className="flex max-w-80">
                  <span className="shrink-0 whitespace-pre">Selected: </span>
                  <LabelText label={selectionLabel(source)} />
                </span>
              </Label>
            )}
            <Item
              className={`max-w-80${operation.destructive ? " text-destructive" : ""}`}
              disabled={unavailable !== null}
              // The menu closes on the same gesture that picks an item, so a dialog opened here would still be under
              // the pointer when the click that follows lands and would take that click as a dismissal.
              onSelect={() => window.setTimeout(() => onSelect(request))}
            >
              <Icon />
              <LabelText label={unavailable ?? operation.label(request)} />
            </Item>
          </Fragment>
        )
      })}
      {separator === "after" && <Separator />}
    </>
  )
}

export function OperationDialog({ onClose, onCompleted, onFailed, repoPath, request }: {
  onClose: () => void
  onCompleted: (completed: CompletedOperation) => void
  onFailed: (message: string) => void
  repoPath: string
  request: OperationRequest
}) {
  const operation = operationById(request.id)
  const [entered, setEntered] = useState<Values>({})
  const [state, setState] = useState<OperationState>({ branch: null, mergeBase: null, prediction: null })
  const { fields, values } = useMemo(() => resolveFields(operation, request, entered), [operation, request, entered])
  const firstTextField = fields.find((field) => field.kind === "text")?.key
  const needs = useMemo(() => operation.needs?.(request, values) ?? {}, [operation, request, values])
  const blocks = operation.blocks(request, state, values)
  const warnings = operation.warnings(request, state, values)
  const plan = blocks.length === 0 ? operation.plan(request, values, state) : null
  const { isPending, mutate } = useMutation({
    mutationFn: (plan: Plan) => invoke<OperationResult>(plan.command, { repoPath, ...plan.args }),
    onSuccess: (result) => {
      if (result.outcome === "failed") {
        onFailed([result.message, ...result.files].join("\n"))
        return
      }
      onCompleted(result)
    },
    onError: (message) => onFailed(String(message)),
  })

  useEffect(() => {
    if (!needs.branch) {
      return
    }
    let disposed = false
    invoke<BranchOperationState>("branch_operation_state", { repoPath, branch: needs.branch })
      .then((branch) => !disposed && setState((current) => ({ ...current, branch })))
      .catch(() => undefined)
    return () => {
      disposed = true
    }
  }, [needs.branch, repoPath])

  useEffect(() => {
    const [left, right] = needs.mergeBase ?? []
    if (!left || !right) {
      return
    }
    let disposed = false
    invoke<string>("merge_base", { repoPath, left, right })
      .then((mergeBase) => !disposed && setState((current) => ({ ...current, mergeBase })))
      .catch((message: unknown) => !disposed && onFailed(String(message)))
    return () => {
      disposed = true
    }
  }, [needs.mergeBase, onFailed, repoPath])

  useEffect(() => {
    const { prediction } = needs
    if (!prediction) {
      return
    }
    let disposed = false
    const timeout = window.setTimeout(() => {
      predictConflicts(repoPath, prediction)
        .then((prediction) => !disposed && setState((current) => ({ ...current, prediction })))
        .catch(() => undefined)
    }, PREDICTION_DEBOUNCE)
    return () => {
      disposed = true
      window.clearTimeout(timeout)
    }
  }, [needs, repoPath])

  const waiting = Boolean(needs.prediction) && state.prediction === null || Boolean(needs.mergeBase) && state.mergeBase === null

  return (
    <AlertDialog onOpenChange={(open) => !open && onClose()} open>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{operationTitle(operation, request)}</AlertDialogTitle>
          <AlertDialogDescription>{operation.description(request, values)}</AlertDialogDescription>
        </AlertDialogHeader>
        {fields.length > 0 && (
          <div className="grid gap-3 text-sm">
            {fields.map((field) => field.kind === "text" ? (
              <label className="grid gap-1" key={field.key}>
                <span className="text-muted-foreground">{field.label}</span>
                <input
                  autoFocus={field.key === firstTextField}
                  className="rounded-lg border bg-transparent px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onChange={(event) => setEntered((current) => ({ ...current, [field.key]: event.target.value }))}
                  placeholder={field.placeholder}
                  value={values[field.key] ?? ""}
                />
              </label>
            ) : field.kind === "toggle" ? (
              <label className="flex items-start gap-2" key={field.key}>
                <input
                  checked={flag(values, field.key)}
                  className="mt-0.5 size-4 accent-primary"
                  onChange={(event) => setEntered((current) => ({ ...current, [field.key]: String(event.target.checked) }))}
                  type="checkbox"
                />
                <span>{field.label}</span>
              </label>
            ) : (
              <fieldset className="grid gap-2" key={field.key}>
                <legend className="text-muted-foreground">{field.label}</legend>
                {field.choices.map((choice) => (
                  <label className="flex items-start gap-2" key={choice.value}>
                    <input
                      checked={values[field.key] === choice.value}
                      className="mt-0.5 size-4 accent-primary"
                      name={field.key}
                      onChange={() => setEntered((current) => ({ ...current, [field.key]: choice.value }))}
                      type="radio"
                    />
                    <span className="min-w-0">
                      <span className="block">{choice.label}</span>
                      {choice.description && <span className="block text-xs text-muted-foreground">{choice.description}</span>}
                    </span>
                  </label>
                ))}
              </fieldset>
            ))}
          </div>
        )}
        {blocks.length > 0 && (
          <p className="text-sm text-muted-foreground">{`Unavailable: ${blocks.map((block) => block.reason).join(", ")}.`}</p>
        )}
        {warnings.length > 0 && (
          <ul className="grid gap-2 text-sm">
            {warnings.map((warning) => (
              <li className="flex items-start gap-2" key={warning.message}>
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-400" />
                <div className="min-w-0">
                  <p>{warning.message}</p>
                  {warning.files && (
                    <ul className="font-mono text-xs text-muted-foreground">
                      {warning.files.map((file) => <li key={file}>{file}</li>)}
                    </ul>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {plan && <code className="overflow-x-auto rounded-lg border p-3 font-mono text-xs whitespace-pre">{plan.argv.join(" ")}</code>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button
            disabled={isPending || !plan || waiting}
            onClick={() => plan && mutate(plan)}
            type="button"
            variant={operation.destructive ? "destructive" : "default"}
          >
            {isPending ? "Working…" : waiting ? "Checking…" : operation.action(request, values)}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
