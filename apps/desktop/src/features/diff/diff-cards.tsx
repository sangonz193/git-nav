import { DiffModeEnum, DiffView } from "@git-diff-view/react"
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FoldVertical,
  UnfoldVertical,
} from "lucide-react"
import {
  type ComponentRef,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import { Button } from "@workspace/shadcn/components/button"
import { cn } from "@workspace/shadcn/lib/utils"
import { Hinted } from "@/components/hinted"
import {
  fileName,
  formatBytes,
  IMAGE_PREVIEW_LIMIT,
  isImagePath,
  isSvgPath,
  svgContent,
  type ChangedFile,
} from "./diff-panel-state"
import { FileStat, FileStatusLetter } from "./file-stat"
import {
  DIFF_FONT_SIZE,
  estimatedBodyHeight,
  isLargeDiff,
  isSvgFile,
  statusLetter,
  type BinaryContent,
  type DiffEntry,
  type FileTreeNode,
} from "./diff-files"

type FileTreeProps = {
  activeKey: string | null
  isDimmed?: (file: ChangedFile) => boolean
  keyOf: (file: ChangedFile) => string
  leading?: (file: ChangedFile) => ReactNode
  onSelect: (file: ChangedFile) => void
}

export function FileTree({
  files,
  ...props
}: FileTreeProps & { files: FileTreeNode[] }) {
  return files.map((node) => (
    <FileTreeNode key={node.path} level={0} node={node} {...props} />
  ))
}

function FileTreeNode({
  level,
  node,
  ...props
}: FileTreeProps & { level: number; node: FileTreeNode }) {
  const [open, setOpen] = useState(true)
  const { activeKey, isDimmed, keyOf, leading, onSelect } = props
  const paddingLeft = 6 + level * 14

  if (node.file) {
    const file = node.file
    const key = keyOf(file)
    return (
      <div
        className={cn(
          "diff-file",
          key === activeKey && "is-selected",
          isDimmed?.(file) && "is-viewed",
        )}
        key={key}
        style={{ paddingLeft }}
      >
        {leading?.(file)}
        <button
          className="diff-file-button"
          onClick={() => onSelect(file)}
          type="button"
        >
          <FileStatusLetter letter={statusLetter(file)} />
          <span className="truncate">{node.name}</span>
          {!file.isBinary && (
            <FileStat additions={file.additions} deletions={file.deletions} />
          )}
        </button>
      </div>
    )
  }

  return (
    <div className="diff-folder">
      <button
        aria-expanded={open}
        className="diff-folder-button"
        onClick={() => setOpen((current) => !current)}
        style={{ paddingLeft }}
        type="button"
      >
        {open ?
          <ChevronDown className="size-3" />
        : <ChevronRight className="size-3" />}
        {open ?
          <FolderOpen className="size-3.5" />
        : <Folder className="size-3.5" />}
        <span className="truncate">{node.name}</span>
      </button>
      {open && (
        <div className="diff-folder-children">
          {node.children.map((child) => (
            <FileTreeNode
              key={child.path}
              level={level + 1}
              node={child}
              {...props}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function BinaryDiff({
  newImage,
  newBinary,
  newPath,
  oldImage,
  oldBinary,
  oldPath,
}: {
  newImage: boolean
  newBinary: BinaryContent | null
  newPath: string | null
  oldImage: boolean
  oldBinary: BinaryContent | null
  oldPath: string | null
}) {
  if (!oldBinary?.image && !newBinary?.image && !oldImage && !newImage) {
    const sizes = [oldBinary, newBinary]
      .filter((content) => content !== null)
      .map((content) => formatBytes(content.size))
    const tooLargeToPreview = [
      { content: oldBinary, path: oldPath },
      { content: newBinary, path: newPath },
    ].some(
      ({ content, path }) =>
        content !== null &&
        isImagePath(path) &&
        content.size > IMAGE_PREVIEW_LIMIT,
    )
    return (
      <p className="diff-file-card-notice">
        {tooLargeToPreview ? "Too large to preview" : "Binary file changed"}
        <span className="text-xs">{sizes.join(" → ")}</span>
      </p>
    )
  }
  return (
    <div className="diff-binary-preview">
      {oldBinary && (
        <ImageSide content={oldBinary} imageType={oldImage} side="old" />
      )}
      {newBinary && (
        <ImageSide content={newBinary} imageType={newImage} side="new" />
      )}
    </div>
  )
}

function ImageSide({
  content,
  imageType,
  side,
}: {
  content: BinaryContent
  imageType: boolean
  side: "old" | "new"
}) {
  const [dimensions, setDimensions] = useState<string | null>(null)
  const [previewFailed, setPreviewFailed] = useState(false)
  return (
    <figure className={`diff-binary-side is-${side}`}>
      {content.image && !previewFailed ?
        <img
          alt={side === "old" ? "Before" : "After"}
          onError={() => setPreviewFailed(true)}
          onLoad={(event) =>
            setDimensions(
              `${event.currentTarget.naturalWidth}×${event.currentTarget.naturalHeight}`,
            )
          }
          src={content.image}
        />
      : <p className="diff-file-card-notice">
          {!previewFailed && imageType && content.size > IMAGE_PREVIEW_LIMIT ?
            "Too large to preview"
          : "No preview"}
        </p>
      }
      <figcaption>
        {formatBytes(content.size)}
        {dimensions && ` · ${dimensions}`}
      </figcaption>
    </figure>
  )
}

function ImageErrorPreview({
  message,
  newImage,
  oldImage,
}: {
  message: string
  newImage: boolean
  oldImage: boolean
}) {
  return (
    <div className="diff-binary-preview">
      {oldImage && <ImageErrorSide message={message} side="old" />}
      {newImage && <ImageErrorSide message={message} side="new" />}
    </div>
  )
}

function ImageErrorSide({
  message,
  side,
}: {
  message: string
  side: "old" | "new"
}) {
  return (
    <figure className={`diff-binary-side is-${side}`}>
      <p className="diff-file-card-notice text-destructive">{message}</p>
      <figcaption>&nbsp;</figcaption>
    </figure>
  )
}

export function FileDiffCard({
  action,
  allExpanded,
  collapsed,
  dimmed,
  entry,
  expanded,
  file,
  mode,
  onExpand,
  onToggleAllExpanded,
  onToggleCollapsed,
  theme,
  wrap,
}: {
  action?: ReactNode
  allExpanded: boolean
  collapsed: boolean
  dimmed?: boolean
  entry: DiffEntry | undefined
  expanded: boolean
  file: ChangedFile
  mode: DiffModeEnum
  onExpand: () => void
  onToggleAllExpanded: () => void
  onToggleCollapsed: () => void
  theme: "light" | "dark"
  wrap: boolean
}) {
  const diffView = useRef<ComponentRef<typeof DiffView>>(null)
  const loaded = entry?.state === "loaded"
  const svg = useMemo(
    () =>
      entry?.state === "loaded" ?
        {
          newBinary:
            isSvgPath(file.newPath) ?
              svgContent(entry.data.newFile.content)
            : null,
          oldBinary:
            isSvgPath(file.oldPath) ?
              svgContent(entry.data.oldFile.content)
            : null,
        }
      : { newBinary: null, oldBinary: null },
    [entry, file],
  )

  // The diff view holds its unfolded context, and a card scrolled out of the virtual window loses that view,
  // so the choice is kept up here and replayed onto whichever view is mounted.
  useEffect(() => {
    const instance = diffView.current?.getDiffFileInstance()
    if (!instance) {
      return
    }
    const modeName = mode & DiffModeEnum.Split ? "split" : "unified"
    const isExpanded =
      modeName === "split" ?
        instance.hasExpandSplitAll
      : instance.hasExpandUnifiedAll
    if (allExpanded && !isExpanded) {
      instance.onAllExpand(modeName)
    } else if (!allExpanded && isExpanded) {
      instance.onAllCollapse(modeName)
    }
  }, [allExpanded, collapsed, loaded, mode])

  const body = () => {
    if (entry?.state === "binary") {
      return (
        <BinaryDiff
          newBinary={entry.newBinary}
          newImage={isImagePath(file.newPath)}
          newPath={file.newPath}
          oldBinary={entry.oldBinary}
          oldImage={isImagePath(file.oldPath)}
          oldPath={file.oldPath}
        />
      )
    }
    if (entry?.state === "error") {
      const oldImage = isImagePath(file.oldPath)
      const newImage = isImagePath(file.newPath)
      if (
        file.isBinary ?
          oldImage || newImage
        : isSvgFile(file) && !isLargeDiff(file)
      ) {
        return (
          <ImageErrorPreview
            message={entry.message}
            newImage={newImage}
            oldImage={oldImage}
          />
        )
      }
      return (
        <p className="diff-file-card-notice text-destructive">
          {entry.message}
        </p>
      )
    }
    if (entry?.state === "loaded") {
      return (
        <>
          {(svg.oldBinary || svg.newBinary) && (
            <BinaryDiff
              newBinary={svg.newBinary}
              newImage
              newPath={file.newPath}
              oldBinary={svg.oldBinary}
              oldImage
              oldPath={file.oldPath}
            />
          )}
          <DiffView
            data={entry.data}
            diffViewFontSize={DIFF_FONT_SIZE}
            diffViewHighlight
            diffViewMode={mode}
            diffViewTheme={theme}
            diffViewWrap={wrap}
            ref={diffView}
          />
        </>
      )
    }
    if (isLargeDiff(file) && !expanded) {
      return (
        <p className="diff-file-card-notice">
          Large diff with {(file.additions + file.deletions).toLocaleString()}{" "}
          changed lines
          <Button onClick={onExpand} size="xs" type="button" variant="outline">
            Show diff
          </Button>
        </p>
      )
    }
    return <div style={{ height: estimatedBodyHeight(file, mode) }} />
  }

  return (
    <article className={cn("diff-file-card", dimmed && "is-viewed")}>
      <header className="diff-file-card-header">
        <button
          aria-expanded={!collapsed}
          className="diff-file-card-toggle"
          onClick={onToggleCollapsed}
          type="button"
        >
          {collapsed ?
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          : <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />}
          <FileStatusLetter letter={statusLetter(file)} />
          <span className="diff-file-card-path truncate">{fileName(file)}</span>
        </button>
        {loaded && !collapsed && (
          <Hinted
            hint={allExpanded ? "Collapse unchanged lines" : "Expand all lines"}
          >
            <Button
              aria-label={
                allExpanded ? "Collapse unchanged lines" : "Expand all lines"
              }
              aria-pressed={allExpanded}
              onClick={onToggleAllExpanded}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              {allExpanded ?
                <FoldVertical className="text-muted-foreground" />
              : <UnfoldVertical className="text-muted-foreground" />}
            </Button>
          </Hinted>
        )}
        {!file.isBinary && (
          <FileStat additions={file.additions} deletions={file.deletions} />
        )}
        {action}
      </header>
      {!collapsed && body()}
    </article>
  )
}
