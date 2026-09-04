import type { SerializedDockview } from "dockview-react"

import type { DiffPanelParams, DiffPanelUserPreferences, GraphPanelParams, GraphPanelUserPreferences } from "./panel-params"

import { createUserWinningRestore } from "./pending-restore"
import { WORKTREE_REF } from "./repository-constants"

export const REPOSITORY_LAYOUT_VERSION = 1

type PanelParams = {
  name?: unknown
  path?: unknown
  baseRef?: unknown
  baseLabel?: unknown
  headRef?: unknown
  headLabel?: unknown
  mergeBase?: unknown
  selectedCommitHashes?: unknown
  selectedFilePath?: unknown
  userPreferences?: unknown
}

type SerializedPanel = {
  contentComponent?: unknown
  params?: PanelParams
}


type RestorablePanel = { id: string, api: { setActive(): void } }
type RestorableContainer<Panel extends RestorablePanel> = {
  panels: Panel[]
  activePanel: Panel | undefined
  fromJSON(layout: SerializedDockview): void
  getPanel(id: string): Panel | undefined
  removePanel(panel: Panel): void
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

type Check<Value> = (value: unknown) => value is Value
// A field the panel writes that this cannot read fails the panel, and a failed panel discards the whole
// layout. Naming the checks after the type they read is what keeps a new field from being written before
// it can be read back.
type Checks<Fields> = { [Key in keyof Required<Fields>]: Check<Required<Fields>[Key]> }
type RequiredKeys<Fields> = { [Key in keyof Fields]-?: object extends Pick<Fields, Key> ? never : Key }[keyof Fields]
type Mandatory<Fields> = Record<RequiredKeys<Fields>, true>

const isString: Check<string> = (value) => typeof value === "string"
const isBoolean: Check<boolean> = (value) => typeof value === "boolean"

const DIFF_PREFERENCE_MANDATORY = {} satisfies Mandatory<DiffPanelUserPreferences>
const GRAPH_PREFERENCE_MANDATORY = {} satisfies Mandatory<GraphPanelUserPreferences>
const DIFF_PARAM_MANDATORY = { baseRef: true, headRef: true, name: true, path: true } satisfies Mandatory<DiffPanelParams>
const GRAPH_PARAM_MANDATORY = { name: true, path: true } satisfies Mandatory<GraphPanelParams>

// A guard may narrow to less than the field allows and still satisfy it, so the values of a field that is
// a union are listed against the union itself rather than repeated inside a guard.
const DIFF_MODES = { split: true, unified: true } satisfies Record<NonNullable<DiffPanelUserPreferences["mode"]>, true>

const DIFF_PREFERENCE_CHECKS = {
  fileTreeOpen: isBoolean,
  hideViewed: isBoolean,
  ignoreWhitespace: isBoolean,
  mode: (value): value is keyof typeof DIFF_MODES => typeof value === "string" && Object.hasOwn(DIFF_MODES, value),
  wrap: isBoolean,
} satisfies Checks<DiffPanelUserPreferences>

const GRAPH_PREFERENCE_CHECKS = {
  columnWidths: (value): value is Record<string, number> =>
    isObject(value) && Object.values(value).every((width) => typeof width === "number" && Number.isFinite(width) && width > 0),
} satisfies Checks<GraphPanelUserPreferences>

const DIFF_PARAM_CHECKS = {
  name: isString,
  path: isString,
  baseRef: isString,
  baseLabel: isString,
  headRef: isString,
  headLabel: isString,
  mergeBase: isBoolean,
  selectedFilePath: (value): value is string | null => value === null || isString(value),
  userPreferences: (value): value is DiffPanelUserPreferences => validFields(value, DIFF_PREFERENCE_CHECKS, DIFF_PREFERENCE_MANDATORY),
} satisfies Checks<DiffPanelParams>

const GRAPH_PARAM_CHECKS = {
  name: isString,
  path: isString,
  selectedCommitHashes: (value): value is string[] => Array.isArray(value) && value.every(isString),
  userPreferences: (value): value is GraphPanelUserPreferences => validFields(value, GRAPH_PREFERENCE_CHECKS, GRAPH_PREFERENCE_MANDATORY),
} satisfies Checks<GraphPanelParams>

function validFields(value: unknown, checks: Record<string, Check<unknown>>, mandatory: Record<string, true>) {
  if (!isObject(value)) {
    return false
  }
  return Object.keys(mandatory).every((key) => value[key] !== undefined)
    && Object.entries(value).every(([key, field]) => Object.hasOwn(checks, key) && checks[key](field))
}

function validGraphParams(params: PanelParams, path: string) {
  return params.path === path && validFields(params, GRAPH_PARAM_CHECKS, GRAPH_PARAM_MANDATORY)
}

function validDiffParams(params: PanelParams) {
  return validFields(params, DIFF_PARAM_CHECKS, DIFF_PARAM_MANDATORY)
}

export function usableRepositoryLayout(value: unknown, path: string): SerializedDockview | null {
  if (!isObject(value) || value.version !== REPOSITORY_LAYOUT_VERSION || !isObject(value.layout)) {
    return null
  }
  const layout = value.layout as unknown as SerializedDockview
  const root = isObject(layout.grid) ? layout.grid.root : null
  if (!isObject(root) || root.type !== "branch" || !Array.isArray(root.data) || !isObject(layout.panels) || Object.keys(layout.panels).length === 0) {
    return null
  }
  for (const panel of Object.values(layout.panels)) {
    const serialized = panel as SerializedPanel
    if (serialized.contentComponent !== "graph" && serialized.contentComponent !== "diff") {
      return null
    }
    const params = serialized.params
    if (!params || typeof params.name !== "string" || typeof params.path !== "string") {
      return null
    }
    if (serialized.contentComponent === "graph" ? !validGraphParams(params, path) : !validDiffParams(params)) {
      return null
    }
  }
  return layout
}

export async function closeRepositoryWindowAfterSaving(
  event: { preventDefault(): void },
  flush: () => Promise<void>,
  destroy: () => Promise<void>,
  saveTimeout = 1_000,
) {
  event.preventDefault()
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve().then(flush).catch(() => undefined),
      new Promise<void>((resolve) => { timeout = globalThis.setTimeout(resolve, saveTimeout) }),
    ])
  } finally {
    globalThis.clearTimeout(timeout)
    await destroy()
  }
}

export function repositoryLayoutSaveScheduler(save: (keepalive?: boolean) => Promise<void>, onError: (error: unknown) => void, isCurrent = () => true) {
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined
  let saveChain = Promise.resolve()
  let normalSavesPending = 0
  const flush = () => {
    if (timeout === undefined) {
      return saveChain
    }
    globalThis.clearTimeout(timeout)
    timeout = undefined
    normalSavesPending++
    saveChain = saveChain.then(async () => {
      try {
        if (isCurrent()) {
          await save()
        }
      } finally {
        normalSavesPending--
      }
    }).catch(onError)
    return saveChain
  }
  return {
    schedule() {
      globalThis.clearTimeout(timeout)
      timeout = globalThis.setTimeout(() => void flush(), 400)
    },
    flush,
    flushOnPageHide() {
      if ((timeout === undefined && normalSavesPending === 0) || !isCurrent()) {
        return
      }
      if (timeout !== undefined) {
        globalThis.clearTimeout(timeout)
        timeout = undefined
      }
      // A pagehide reissue can race an in-flight save and the later write wins; losing the save entirely on unload is worse.
      const unloadSave = save(true).catch(onError)
      saveChain = Promise.all([saveChain, unloadSave]).then(() => undefined)
    },
    dispose() {
      void flush()
    },
  }
}

export function repositoryLayoutRestoreController(save: () => void) {
  const restore = createUserWinningRestore(true)
  let saveEnabled = false
  let applyingRestore = false
  let restoreApplyFailed = false
  const changed = () => {
    if (saveEnabled && !applyingRestore) {
      save()
    }
  }
  const apply = (change: () => void) => {
    applyingRestore = true
    try {
      change()
    } finally {
      applyingRestore = false
    }
  }

  return {
    get pending() {
      return restore.pending
    },
    changed,
    userAction() {
      if (!restore.pending) {
        return false
      }
      restore.userAction(() => undefined)
      saveEnabled = true
      return true
    },
    restored(change: () => void) {
      return restore.restore(() => {
        saveEnabled = true
        try {
          apply(change)
        } catch (error) {
          saveEnabled = false
          restoreApplyFailed = true
          throw error
        }
        changed()
      })
    },
    failed(change: () => void) {
      if (!restore.cancel() && !restoreApplyFailed) {
        return false
      }
      restoreApplyFailed = false
      apply(change)
      return true
    },
  }
}

export function listenForRepositoryLayoutPageHide(target: Pick<EventTarget, "addEventListener" | "removeEventListener">, flush: () => void) {
  target.addEventListener("pagehide", flush)
  return () => target.removeEventListener("pagehide", flush)
}

function panelRevisions(panel: SerializedPanel) {
  const params = panel.params
  if (panel.contentComponent !== "diff" || typeof params?.path !== "string") {
    return null
  }
  return {
    path: params.path,
    revisions: [params.baseRef, params.headRef].filter((ref): ref is string => typeof ref === "string" && ref !== WORKTREE_REF),
  }
}

export async function unresolvablePanelIds(layout: SerializedDockview, resolveRevision: (path: string, revision: string) => Promise<unknown>) {
  const resolutions = await Promise.all(Object.entries(layout.panels).map(async ([id, panel]) => {
    const panelRevision = panelRevisions(panel as SerializedPanel)
    if (!panelRevision) {
      return null
    }
    const resolved = await Promise.all(panelRevision.revisions.map((revision) => resolveRevision(panelRevision.path, revision).then(() => true).catch(() => false)))
    return resolved.every(Boolean) ? null : id
  }))
  return resolutions.filter((id): id is string => id !== null)
}

export function restoreRepositoryLayout<Panel extends RestorablePanel>(container: RestorableContainer<Panel>, layout: SerializedDockview, invalidPanelIds: string[]) {
  container.fromJSON(layout)
  invalidPanelIds.forEach((id) => {
    const panel = container.getPanel(id)
    if (panel) {
      container.removePanel(panel)
    }
  })
  if (!container.activePanel) {
    container.panels[0]?.api.setActive()
  }
  return container.panels.length > 0
}
