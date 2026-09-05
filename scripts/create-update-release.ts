import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { basename, join, resolve } from "node:path"

const [artifactsDirectory, releaseDirectory, tag] = Bun.argv.slice(2)

if (!artifactsDirectory || !releaseDirectory || !tag) {
  throw new Error(
    "Usage: bun scripts/create-update-release.ts <artifacts-directory> <release-directory> <tag>"
  )
}

const platformTargets = {
  "darwin-arm64": "darwin-aarch64",
  "darwin-x64": "darwin-x86_64",
  "linux-arm64": "linux-aarch64",
  "linux-x64": "linux-x86_64",
  "win32-arm64": "windows-aarch64",
  "win32-x64": "windows-x86_64",
}

await mkdir(releaseDirectory, { recursive: true })

const platforms = {}
for (const [platform, target] of Object.entries(platformTargets)) {
  const bundleDirectory = resolve(artifactsDirectory, `installer-${platform}`)
  const files = await bundledFiles(bundleDirectory)
  const updaterArtifacts = updaterArtifactsFor(platform, target, files)

  for (const [updaterTarget, updaterArtifact] of updaterArtifacts) {
    const signature = `${updaterArtifact}.sig`
    if (!files.includes(signature)) {
      throw new Error(`Missing updater signature for ${updaterTarget}.`)
    }

    const releaseName = `${platform}-${basename(updaterArtifact)}`
    await cp(
      join(bundleDirectory, updaterArtifact),
      join(releaseDirectory, releaseName)
    )
    platforms[updaterTarget] = {
      signature: (
        await readFile(join(bundleDirectory, signature), "utf8")
      ).trim(),
      url: `https://github.com/sangonz193/git-nav/releases/download/${tag}/${encodeURIComponent(releaseName)}`,
    }
  }

  for (const file of files.filter(
    (file) =>
      !updaterArtifacts.some(([, artifact]) => artifact === file) &&
      isInstaller(file)
  )) {
    await cp(
      join(bundleDirectory, file),
      join(releaseDirectory, `${platform}-${basename(file)}`)
    )
  }
}

await writeFile(
  join(releaseDirectory, "latest.json"),
  `${JSON.stringify(
    {
      version: tag.replace(/^v/, ""),
      pub_date: new Date().toISOString(),
      platforms,
    },
    null,
    2
  )}\n`
)

async function bundledFiles(directory) {
  const files = []
  for (const entry of await readdir(directory)) {
    const path = join(directory, entry)
    if ((await stat(path)).isDirectory()) {
      for (const nested of await bundledFiles(path))
        files.push(join(entry, nested))
    } else {
      files.push(entry)
    }
  }
  return files
}

function updaterArtifactsFor(platform, target, files) {
  if (platform.startsWith("linux-")) {
    return [
      [target, only(files, (file) => file.endsWith(".AppImage"), platform)],
      [`${target}-deb`, only(files, (file) => file.endsWith(".deb"), platform)],
      [`${target}-rpm`, only(files, (file) => file.endsWith(".rpm"), platform)],
    ]
  }

  return [[target, updaterArtifactFor(platform, files)]]
}

function updaterArtifactFor(platform, files) {
  if (platform.startsWith("darwin-"))
    return only(files, (file) => file.endsWith(".app.tar.gz"), platform)
  return only(files, (file) => file.endsWith(".exe"), platform)
}

function isInstaller(file) {
  return /\.(dmg|deb|rpm|AppImage|exe)$/.test(file)
}

function only(files, matches, platform) {
  const matching = files.filter(matches)
  if (matching.length !== 1) {
    throw new Error(
      `Expected one updater artifact for ${platform}, found ${matching.length}.`
    )
  }
  return matching[0]
}
