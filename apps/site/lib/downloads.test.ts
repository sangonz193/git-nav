import { expect, test } from "bun:test"

import { platformDownloads } from "./downloads"

// The names the release workflow uploads: every installer copied out of the bundle directory is
// prefixed with the platform it was built on.
const ASSETS = [
  "darwin-arm64-Git Nav.app.tar.gz",
  "darwin-arm64-Git Nav_0.0.6_aarch64.dmg",
  "darwin-x64-Git Nav_0.0.6_x64.dmg",
  "win32-arm64-Git Nav_0.0.6_arm64-setup.exe",
  "win32-x64-Git Nav_0.0.6_x64-setup.exe",
  "linux-arm64-git-nav_0.0.6_aarch64.AppImage",
  "linux-x64-git-nav_0.0.6_amd64.AppImage",
  "linux-x64-git-nav_0.0.6_amd64.deb",
  "linux-x64-git-nav-0.0.6-1.x86_64.rpm",
  "latest.json",
].map((name) => ({
  browser_download_url: `https://example.test/${encodeURIComponent(name)}`,
  name,
}))

function builds(assets: typeof ASSETS, key: string) {
  return (
    platformDownloads(assets).find((platform) => platform.key === key)
      ?.builds ?? []
  )
}

test("offers the installer for each platform, newest architecture first", () => {
  expect(builds(ASSETS, "mac").map((build) => build.label)).toEqual([
    "Apple silicon",
    "Intel",
  ])
  expect(builds(ASSETS, "windows").map((build) => build.label)).toEqual([
    "x64",
    "arm64",
  ])
  expect(builds(ASSETS, "linux").map((build) => build.label)).toEqual([
    "AppImage (x64)",
    "deb (x64)",
    "rpm (x64)",
  ])
})

test("never offers an updater artifact as a download", () => {
  const mac = builds(ASSETS, "mac")
  expect(mac.every((build) => !build.url.includes("app.tar.gz"))).toBe(true)
})

test("leaves a platform empty when its build is missing", () => {
  const assets = ASSETS.filter((asset) => !asset.name.startsWith("win32-"))
  expect(builds(assets, "windows")).toEqual([])
  expect(builds(assets, "mac")).toHaveLength(2)
})
