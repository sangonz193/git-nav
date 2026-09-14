// Tauri's AppImage bundles Ubuntu's libwayland, which shadows the host copy that the host's Mesa
// EGL driver is built against. On distributions with a newer Mesa the driver then fails to load
// and WebKit aborts with EGL_BAD_PARAMETER, leaving a blank window. Rebuilding the image without
// those libraries makes the app pick up the host's, which is what the host GL stack expects.
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { basename, dirname, resolve } from "node:path"
import { $ } from "bun"

const desktopRoot = resolve(import.meta.dir, "..")
const toolsRoot = resolve(desktopRoot, "src-tauri", "target", "appimage-tools")
const shadowingLibraries = [
  "libwayland-client.so.0",
  "libwayland-cursor.so.0",
  "libwayland-egl.so.1",
  "libwayland-server.so.0",
]
const appImageTools = {
  x86_64: {
    checksum:
      "ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0",
    runtimeChecksum:
      "2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d",
  },
  aarch64: {
    checksum:
      "f0837e7448a0c1e4e650a93bb3e85802546e60654ef287576f46c71c126a9158",
    runtimeChecksum:
      "00cbdfcf917cc6c0ff6d3347d59e0ca1f7f45a6df1a428a0d6d8a78664d87444",
  },
}

const appImage = Bun.argv[2] && resolve(Bun.argv[2])
if (!appImage) {
  throw new Error("Usage: bun repack-appimage.ts <AppImage>")
}
await stat(appImage)

const architecture = (() => {
  switch (process.arch) {
    case "x64":
      return "x86_64"
    case "arm64":
      return "aarch64"
    default:
      throw new Error(`Unsupported architecture: ${process.arch}`)
  }
})()

if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
  await rm(`${appImage}.sig`, { force: true })
}

const workingDirectory = resolve(
  dirname(appImage),
  `${basename(appImage)}.repack`,
)
await rm(workingDirectory, { recursive: true, force: true })
await mkdir(workingDirectory, { recursive: true })
await $`${appImage} --appimage-extract`.cwd(workingDirectory).quiet()
const appDir = resolve(workingDirectory, "squashfs-root")

for (const library of shadowingLibraries) {
  await rm(resolve(appDir, "usr", "lib", library), { force: true })
}

const { appImageTool, runtime } = await appImageToolFor(architecture)
const repackEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      name !== "TAURI_SIGNING_PRIVATE_KEY" &&
      name !== "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  ),
)
await $`${appImageTool} --appimage-extract-and-run --no-appstream --runtime-file ${runtime} ${appDir} ${appImage}`
  .env({ ...repackEnvironment, ARCH: architecture })
  .quiet()
await rm(workingDirectory, { recursive: true, force: true })

if (process.env.TAURI_SIGNING_PRIVATE_KEY) {
  await $`bun run tauri signer sign ${appImage}`.cwd(desktopRoot).quiet()
}

async function appImageToolFor(architecture: string) {
  const tool = appImageTools[architecture as keyof typeof appImageTools]
  if (!tool) {
    throw new Error(`Unsupported appimagetool architecture: ${architecture}`)
  }

  const appImageTool = resolve(
    toolsRoot,
    `appimagetool-${architecture}.AppImage`,
  )
  const runtime = resolve(toolsRoot, `runtime-${architecture}`)
  await mkdir(toolsRoot, { recursive: true })
  await downloadAndVerify(
    appImageTool,
    `https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-${architecture}.AppImage`,
    tool.checksum,
  )
  await chmod(appImageTool, 0o755)
  await downloadAndVerify(
    runtime,
    `https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-${architecture}`,
    tool.runtimeChecksum,
  )
  return { appImageTool, runtime }
}

async function downloadAndVerify(path: string, url: string, checksum: string) {
  const cachedArtifactIsValid = await verifyChecksum(path, checksum).then(
    () => true,
    () => false,
  )
  if (cachedArtifactIsValid) {
    return
  }

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to download ${basename(path)}: ${response.status}`)
  }
  const contents = Buffer.from(await response.arrayBuffer())
  await verifyChecksum(contents, checksum)
  await writeFile(path, contents)
}

async function verifyChecksum(path: string | Buffer, expected: string) {
  const contents = typeof path === "string" ? await readFile(path) : path
  const actual = createHash("sha256").update(contents).digest("hex")
  if (actual !== expected) {
    throw new Error(
      `Checksum mismatch for ${typeof path === "string" ? basename(path) : "download"}`,
    )
  }
}
