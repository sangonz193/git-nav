export type Asset = { browser_download_url: string; name: string }
export type Download = { label: string; url: string }
export type PlatformDownloads = {
  key: PlatformKey
  name: string
  builds: Download[]
}
export type PlatformKey = "linux" | "mac" | "windows"

export const RELEASES = "https://github.com/sangonz193/git-nav/releases"

const LATEST_RELEASE =
  "https://api.github.com/repos/sangonz193/git-nav/releases/latest"

const NAMES: Record<PlatformKey, string> = {
  linux: "Linux",
  mac: "macOS",
  windows: "Windows",
}

// Release assets are named after the platform they were built on, which is what tells two builds of
// the same installer apart.
const BUILDS: {
  extension: string
  label: string
  platform: PlatformKey
  prefix: string
}[] = [
  {
    extension: ".dmg",
    label: "Apple silicon",
    platform: "mac",
    prefix: "darwin-arm64",
  },
  { extension: ".dmg", label: "Intel", platform: "mac", prefix: "darwin-x64" },
  { extension: ".exe", label: "x64", platform: "windows", prefix: "win32-x64" },
  {
    extension: ".exe",
    label: "arm64",
    platform: "windows",
    prefix: "win32-arm64",
  },
  {
    extension: ".AppImage",
    label: "AppImage (x64)",
    platform: "linux",
    prefix: "linux-x64",
  },
  {
    extension: ".deb",
    label: "deb (x64)",
    platform: "linux",
    prefix: "linux-x64",
  },
  {
    extension: ".rpm",
    label: "rpm (x64)",
    platform: "linux",
    prefix: "linux-x64",
  },
]

export function platformDownloads(assets: Asset[]): PlatformDownloads[] {
  return (Object.keys(NAMES) as PlatformKey[]).map((key) => ({
    key,
    name: NAMES[key],
    builds: BUILDS.filter((build) => build.platform === key).flatMap(
      (build) => {
        const asset = assets.find(
          (candidate) =>
            candidate.name.startsWith(build.prefix) &&
            candidate.name.endsWith(build.extension)
        )
        return asset
          ? [{ label: build.label, url: asset.browser_download_url }]
          : []
      }
    ),
  }))
}

// A release the API will not answer for leaves the releases page to stand in for the assets, so the
// page always has somewhere to send a download.
export async function latestDownloads(): Promise<PlatformDownloads[]> {
  let assets: Asset[] = []
  try {
    const response = await fetch(LATEST_RELEASE, {
      headers: { accept: "application/vnd.github+json" },
      next: { revalidate: 3600 },
    })
    if (response.ok) {
      assets = ((await response.json()) as { assets?: Asset[] }).assets ?? []
    }
  } catch {
    assets = []
  }

  return platformDownloads(assets)
}
