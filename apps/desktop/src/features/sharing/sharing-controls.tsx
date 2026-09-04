import {
  Copy,
  LoaderCircle,
  MonitorSmartphone,
  QrCode,
  RadioTower,
  Settings,
  SquarePen,
  X,
} from "lucide-react"
import { QRCodeSVG } from "qrcode.react"
import { useEffect, useState } from "react"

import { Button } from "@workspace/shadcn/components/button"
import { Checkbox } from "@workspace/shadcn/components/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/shadcn/components/dialog"
import { Input } from "@workspace/shadcn/components/input"
import { toast } from "@workspace/shadcn/components/sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/shadcn/components/tooltip"
import { invoke, isDesktop } from "@/lib/ipc"
import { loadSettings, saveSetting } from "@/lib/settings"
import {
  defaultSharingSettings,
  displayedSharingSettings,
  sharingPort,
  sharingPublicUrl,
  sharingSettings,
  type SharingSettings,
  type SharingState,
  useSharingState,
} from "./sharing-state"

function entryUrl(state: SharingState | null) {
  return state?.entryUrls[0] ?? ""
}

function IconButton({
  children,
  label,
  onClick,
}: {
  children: React.ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          onClick={onClick}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function SharingSettingsDialog({
  onOpenChange,
  open,
  state,
}: {
  onOpenChange: (open: boolean) => void
  open: boolean
  state: SharingState | null
}) {
  const [settings, setSettings] = useState<SharingSettings>(
    defaultSharingSettings
  )
  const [savedSettings, setSavedSettings] = useState<SharingSettings>(
    defaultSharingSettings
  )
  const [portInput, setPortInput] = useState(
    String(defaultSharingSettings.port)
  )
  const [error, setError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    if (!open || !isDesktop) return
    void loadSettings()
      .then((stored) => {
        const displayed = displayedSharingSettings(
          sharingSettings(stored),
          state
        )
        setSettings(displayed)
        setSavedSettings(displayed)
        setPortInput(String(displayed.port))
      })
      .catch((message: unknown) => setError(String(message)))
  }, [open, state])

  async function updateSetting<Key extends keyof SharingSettings>(
    key: Key,
    value: SharingSettings[Key]
  ) {
    if (value === savedSettings[key]) return
    const next = { ...settings, [key]: value }
    setSettings(next)
    setError(null)
    setIsSaving(true)
    try {
      const settingKey = {
        host: "serve.host",
        port: "serve.port",
        publicUrl: "serve.publicUrl",
        startSharing: "serve.startSharing",
      }[key]
      if (state?.sharing && key !== "startSharing") {
        // The backend restarts from the running configuration with only this
        // setting replaced, so command-line overrides for the others survive.
        await invoke<SharingState>("update_sharing_setting", {
          key: settingKey,
          value,
        })
        if (key === "port") {
          toast.success("Sharing restarted", {
            description: `Now using port ${value}.`,
          })
        }
      } else {
        await saveSetting(settingKey, value)
      }
      setSavedSettings(next)
    } catch (message) {
      setError(String(message))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Network sharing settings</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <label className="grid gap-1.5">
            <span className="font-medium">Port</span>
            <Input
              disabled={isSaving}
              max={65535}
              min={1024}
              onBlur={() => {
                const port = sharingPort(Number(portInput))
                if (port === null) {
                  setError("The port must be a number between 1024 and 65535.")
                  return
                }
                setError(null)
                void updateSetting("port", port)
              }}
              onChange={(event) => setPortInput(event.target.value)}
              type="number"
              value={portInput}
            />
          </label>
          <label className="grid gap-1.5">
            <span className="font-medium">Reachable from</span>
            <select
              className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              disabled={isSaving}
              onChange={(event) =>
                void updateSetting(
                  "host",
                  event.target.value as SharingSettings["host"]
                )
              }
              value={settings.host}
            >
              <option value="0.0.0.0">This network</option>
              <option value="127.0.0.1">This computer only</option>
            </select>
          </label>
          <label className="flex items-start gap-2">
            <Checkbox
              checked={settings.startSharing}
              disabled={isSaving}
              onCheckedChange={(checked) =>
                void updateSetting("startSharing", checked === true)
              }
            />
            <span className="grid gap-0.5">
              <span className="font-medium">
                Start sharing when Git Nav opens
              </span>
              <span className="text-muted-foreground">Off by default.</span>
            </span>
          </label>
          <label className="grid gap-1.5">
            <span className="font-medium">Public URL</span>
            <Input
              disabled={isSaving}
              onBlur={(event) => {
                const publicUrl = sharingPublicUrl(event.target.value)
                if (publicUrl === null) {
                  setError("The public URL must be an http or https address.")
                  return
                }
                setError(null)
                void updateSetting("publicUrl", publicUrl)
              }}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  publicUrl: event.target.value,
                }))
              }
              placeholder="https://git-nav.example"
              type="url"
              value={settings.publicUrl}
            />
            <span className="text-xs text-muted-foreground">
              A path in this URL is ignored.
            </span>
          </label>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  )
}

function SharingQrDialog({
  onOpenChange,
  onSettings,
  open,
  showStop = false,
  state,
}: {
  onOpenChange: (open: boolean) => void
  onSettings: () => void
  open: boolean
  showStop?: boolean
  state: SharingState | null
}) {
  const [isRotating, setIsRotating] = useState(false)
  const [isStopping, setIsStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const url = entryUrl(state)

  async function rotateLink() {
    setError(null)
    setIsRotating(true)
    try {
      await invoke<SharingState>("rotate_sharing_token")
    } catch (message) {
      setError(String(message))
    } finally {
      setIsRotating(false)
    }
  }

  async function stopSharing() {
    setError(null)
    setIsStopping(true)
    try {
      await invoke<SharingState>("stop_sharing")
      onOpenChange(false)
    } catch (message) {
      setError(String(message))
    } finally {
      setIsStopping(false)
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Open Git Nav on another device</DialogTitle>
          <DialogDescription>
            Scanning this code opens the shared Git Nav.
          </DialogDescription>
        </DialogHeader>
        {url && (
          <div className="grid justify-items-center gap-3">
            <div className="rounded-lg bg-white p-3">
              <QRCodeSVG size={240} value={url} />
            </div>
            <p className="w-full text-center font-mono text-xs break-all">
              {url}
            </p>
          </div>
        )}
        {state && state.entryUrls.length > 1 && (
          <div className="grid gap-1">
            <p className="font-medium">Other network addresses</p>
            {state.entryUrls.slice(1).map((otherUrl) => (
              <p
                className="font-mono text-xs break-all text-muted-foreground"
                key={otherUrl}
              >
                {otherUrl}
              </p>
            ))}
          </div>
        )}
        <p className="text-sm text-muted-foreground">
          Creating a new link invalidates existing browser cookies.
        </p>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button
            disabled={isRotating || isStopping}
            onClick={onSettings}
            type="button"
            variant="outline"
          >
            <Settings />
            Settings
          </Button>
          <Button
            disabled={isRotating || isStopping}
            onClick={() => void rotateLink()}
            type="button"
            variant="outline"
          >
            {isRotating ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <SquarePen />
            )}
            {isRotating ? "Creating…" : "New link"}
          </Button>
          {showStop && (
            <Button
              disabled={isStopping || isRotating}
              onClick={() => void stopSharing()}
              type="button"
              variant="outline"
            >
              {isStopping ? <LoaderCircle className="animate-spin" /> : <X />}
              {isStopping ? "Stopping…" : "Stop"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SharingDialogs({
  qrOpen,
  setQrOpen,
  settingsOpen,
  setSettingsOpen,
  showStop = false,
  state,
}: {
  qrOpen: boolean
  setQrOpen: (open: boolean) => void
  settingsOpen: boolean
  setSettingsOpen: (open: boolean) => void
  showStop?: boolean
  state: SharingState | null
}) {
  return (
    <>
      <SharingQrDialog
        onOpenChange={setQrOpen}
        onSettings={() => {
          setQrOpen(false)
          setSettingsOpen(true)
        }}
        open={qrOpen}
        showStop={showStop}
        state={state}
      />
      <SharingSettingsDialog
        onOpenChange={setSettingsOpen}
        open={settingsOpen}
        state={state}
      />
    </>
  )
}

export function NetworkSharingRow() {
  const state = useSharingState()
  const [error, setError] = useState<string | null>(null)
  const [isChanging, setIsChanging] = useState(false)
  const [qrOpen, setQrOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  if (!isDesktop) return null

  const sharing = state?.sharing === true
  const url = entryUrl(state)

  async function changeSharing(command: "start_sharing" | "stop_sharing") {
    setError(null)
    setIsChanging(true)
    try {
      await invoke<SharingState>(command)
    } catch (message) {
      setError(String(message))
    } finally {
      setIsChanging(false)
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url)
      toast.success("Link copied")
    } catch (message) {
      setError(String(message))
    }
  }

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-start gap-3">
        <MonitorSmartphone
          className={`mt-0.5 size-5 shrink-0 ${sharing ? "text-primary" : "text-muted-foreground"}`}
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {sharing ? "Sharing on the network" : "Share on the network"}
          </p>
          {!sharing && (
            <p className="text-sm text-muted-foreground">
              Open Git Nav from another device on your network.
            </p>
          )}
          {sharing && (
            <div className="mt-2 flex min-w-0 items-center gap-1">
              <p className="min-w-0 flex-1 truncate font-mono text-xs">{url}</p>
              <IconButton label="Copy link" onClick={() => void copyLink()}>
                <Copy />
              </IconButton>
              <IconButton label="Show QR code" onClick={() => setQrOpen(true)}>
                <QrCode />
              </IconButton>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton
            label="Network sharing settings"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings />
          </IconButton>
          <Button
            disabled={isChanging}
            onClick={() =>
              void changeSharing(sharing ? "stop_sharing" : "start_sharing")
            }
            size="sm"
            type="button"
            variant={sharing ? "outline" : "default"}
          >
            {isChanging && <LoaderCircle className="animate-spin" />}
            {isChanging
              ? sharing
                ? "Stopping…"
                : "Starting…"
              : sharing
                ? "Stop"
                : "Start"}
          </Button>
        </div>
      </div>
      {sharing && (
        <p className="mt-3 text-xs text-muted-foreground">
          Anyone with the link can browse and modify your repositories.
        </p>
      )}
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      <SharingDialogs
        qrOpen={qrOpen}
        setQrOpen={setQrOpen}
        setSettingsOpen={setSettingsOpen}
        settingsOpen={settingsOpen}
        state={state}
      />
    </div>
  )
}

export function SharingIndicator() {
  const state = useSharingState()
  const [qrOpen, setQrOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  if (!isDesktop) return null

  return (
    <>
      {state?.sharing === true && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Sharing on the network"
              className="text-primary"
              onClick={() => setQrOpen(true)}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <RadioTower className="size-7" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Sharing on the network</TooltipContent>
        </Tooltip>
      )}
      {/* Stopping sharing unmounts the icon, so the dialogs render beside it rather than inside. */}
      <SharingDialogs
        qrOpen={qrOpen}
        setQrOpen={setQrOpen}
        setSettingsOpen={setSettingsOpen}
        settingsOpen={settingsOpen}
        showStop
        state={state}
      />
    </>
  )
}
