// Tauri offers no hook after bundling, so the AppImage repack that a Linux build needs before it
// can run on a current Mesa follows `tauri build` here rather than in whatever packages it next.
import { readdir } from "node:fs/promises"
import { resolve } from "node:path"
import { $ } from "bun"

const desktopRoot = resolve(import.meta.dir, "..")
const tauriRoot = resolve(desktopRoot, "src-tauri")

await $`bun run tauri build ${Bun.argv.slice(2)}`.cwd(desktopRoot)

if (process.platform === "linux") {
  const metadata = await $`cargo metadata --format-version 1 --no-deps`
    .cwd(tauriRoot)
    .json()
  const appImageRoot = resolve(
    metadata.target_directory,
    "release",
    "bundle",
    "appimage",
  )
  const appImages = await readdir(appImageRoot).then(
    (entries) => entries.filter((entry) => entry.endsWith(".AppImage")),
    () => [],
  )
  for (const appImage of appImages) {
    await $`bun ${resolve(import.meta.dir, "repack-appimage.ts")} ${resolve(appImageRoot, appImage)}`
  }
}
