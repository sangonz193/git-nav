"use client"

import { Download } from "lucide-react"
import { useSyncExternalStore } from "react"

import {
  RELEASES,
  type PlatformDownloads,
  type PlatformKey,
} from "@/lib/downloads"

function subscribe() {
  return () => {}
}

function detectPlatform(): PlatformKey | null {
  const value = `${navigator.platform} ${navigator.userAgent}`.toLowerCase()
  if (value.includes("mac")) return "mac"
  if (value.includes("win")) return "windows"
  if (value.includes("linux") || value.includes("x11")) return "linux"
  return null
}

export function DownloadCta({ platforms }: { platforms: PlatformDownloads[] }) {
  // The page is prerendered, so the platform is unknown until it runs in a browser and the button
  // names the release page in the meantime.
  const platform = useSyncExternalStore(subscribe, detectPlatform, () => null)

  const detected = platforms.find((candidate) => candidate.key === platform)
  const primary = detected?.builds[0]
  const alternates = detected?.builds.slice(1) ?? []

  return (
    <div className="space-y-3">
      <a
        className="inline-flex items-center gap-2.5 rounded-xl bg-foreground px-5 py-3 font-medium text-background transition-opacity hover:opacity-90"
        href={primary?.url ?? RELEASES}
      >
        <Download className="size-4.5" />
        {detected ? `Download for ${detected.name}` : "Download Git Nav"}
      </a>
      <p className="text-sm text-muted-foreground">
        {alternates.map((build) => (
          <span key={build.label}>
            <a
              className="underline-offset-4 hover:text-foreground hover:underline"
              href={build.url}
            >
              {build.label}
            </a>
            {" · "}
          </span>
        ))}
        <a
          className="underline-offset-4 hover:text-foreground hover:underline"
          href={RELEASES}
        >
          {alternates.length > 0
            ? "Other platforms"
            : "macOS, Windows and Linux"}
        </a>
        . Free and open source.
      </p>
    </div>
  )
}
