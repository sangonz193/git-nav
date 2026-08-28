import { ChevronRight, CornerLeftUp, FolderGit2, Folder } from "lucide-react"
import { useEffect, useState } from "react"

import { Button } from "@workspace/shadcn/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/shadcn/components/dialog"
import { invoke } from "@/lib/ipc"

type DirectoryEntry = { name: string; path: string; isRepository: boolean }
type DirectoryListing = {
  path: string
  parent: string | null
  isRepository: boolean
  entries: DirectoryEntry[]
}

export function FolderPicker({
  onCancel,
  onChoose,
  open,
}: {
  onCancel: () => void
  onChoose: (path: string) => void
  open: boolean
}) {
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [path, setPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let disposed = false
    invoke<DirectoryListing>("list_directory", { path })
      .then((listing) => {
        if (!disposed) {
          setListing(listing)
          setError(null)
        }
      })
      .catch((message: unknown) => {
        if (!disposed) setError(String(message))
      })
    return () => {
      disposed = true
    }
  }, [open, path])

  return (
    <Dialog onOpenChange={(next) => !next && onCancel()} open={open}>
      <DialogContent className="max-h-[80svh] gap-4 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Choose a Git repository</DialogTitle>
          <DialogDescription className="truncate font-mono text-xs">
            {listing?.path ?? "Loading…"}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-64 flex-1 overflow-y-auto rounded-lg border">
          {listing?.parent && (
            <button
              className="flex w-full items-center gap-3 border-b px-3 py-2.5 text-left transition-colors hover:bg-muted"
              onClick={() => setPath(listing.parent)}
              type="button"
            >
              <CornerLeftUp className="size-4 shrink-0 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Parent folder</span>
            </button>
          )}
          {listing?.entries.map((entry) => (
            <button
              className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted"
              key={entry.path}
              onClick={() => setPath(entry.path)}
              type="button"
            >
              {entry.isRepository ? (
                <FolderGit2 className="size-4 shrink-0 text-primary" />
              ) : (
                <Folder className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate text-sm">{entry.name}</span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </button>
          ))}
          {listing?.entries.length === 0 && (
            <p className="p-3 text-sm text-muted-foreground">No subfolders</p>
          )}
          {error && <p className="p-3 text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button onClick={onCancel} type="button" variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={!listing?.isRepository}
            onClick={() => listing && onChoose(listing.path)}
            type="button"
          >
            {listing?.isRepository ? "Open this folder" : "Not a Git repository"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
