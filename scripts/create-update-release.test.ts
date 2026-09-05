import { afterEach, describe, expect, test } from "bun:test"
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

let temporaryDirectory: string | undefined

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true })
  temporaryDirectory = undefined
})

describe("create-update-release", () => {
  test("publishes installer-specific Linux updater entries", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "git-nav-release-"))
    const artifactsDirectory = join(temporaryDirectory, "artifacts")
    const releaseDirectory = join(temporaryDirectory, "release")

    await createArtifacts(artifactsDirectory)

    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "create-update-release.ts"),
        artifactsDirectory,
        releaseDirectory,
        "v1.2.3",
      ],
      { stderr: "pipe" }
    )
    const stderr = await new Response(child.stderr).text()
    expect(await child.exited, stderr).toBe(0)

    const manifest = JSON.parse(
      await readFile(join(releaseDirectory, "latest.json"), "utf8")
    )

    for (const [platform, target] of [
      ["linux-arm64", "linux-aarch64"],
      ["linux-x64", "linux-x86_64"],
    ]) {
      expect(manifest.platforms[target].url).toEndWith(
        `/${platform}-Git.Nav.AppImage`
      )
      expect(manifest.platforms[`${target}-deb`]).toEqual({
        signature: `${platform}-deb-signature`,
        url: `https://github.com/sangonz193/git-nav/releases/download/v1.2.3/${platform}-Git.Nav.deb`,
      })
      expect(manifest.platforms[`${target}-rpm`]).toEqual({
        signature: `${platform}-rpm-signature`,
        url: `https://github.com/sangonz193/git-nav/releases/download/v1.2.3/${platform}-Git.Nav.rpm`,
      })
      expect(
        await readFile(
          join(releaseDirectory, `${platform}-Git.Nav.deb`),
          "utf8"
        )
      ).toBe(`${platform}-deb`)
      expect(
        await readFile(
          join(releaseDirectory, `${platform}-Git.Nav.rpm`),
          "utf8"
        )
      ).toBe(`${platform}-rpm`)
    }
  })

  test("names every asset the way GitHub stores it", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "git-nav-release-"))
    const artifactsDirectory = join(temporaryDirectory, "artifacts")
    const releaseDirectory = join(temporaryDirectory, "release")

    await createArtifacts(artifactsDirectory)

    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "create-update-release.ts"),
        artifactsDirectory,
        releaseDirectory,
        "v1.2.3",
      ],
      { stderr: "pipe" }
    )
    const stderr = await new Response(child.stderr).text()
    expect(await child.exited, stderr).toBe(0)

    const manifest = JSON.parse(
      await readFile(join(releaseDirectory, "latest.json"), "utf8")
    )
    const released = await readdir(releaseDirectory)

    for (const [target, entry] of Object.entries<{ url: string }>(
      manifest.platforms
    )) {
      expect(entry.url).not.toContain("%")
      expect([
        target,
        decodeURIComponent(entry.url.split("/").pop() ?? ""),
      ]).toEqual([
        target,
        released.find((name) => entry.url.endsWith(`/${name}`)) ?? "missing",
      ])
    }
  })
})

async function createArtifacts(artifactsDirectory: string) {
  for (const platform of ["darwin-arm64", "darwin-x64"]) {
    await writeArtifacts(artifactsDirectory, platform, [
      ["Git Nav.app.tar.gz", `${platform}-app`],
      ["Git Nav.app.tar.gz.sig", `${platform}-app-signature`],
      ["Git Nav.dmg", `${platform}-dmg`],
    ])
  }

  for (const platform of ["linux-arm64", "linux-x64"]) {
    await writeArtifacts(artifactsDirectory, platform, [
      ["Git Nav.AppImage", `${platform}-appimage`],
      ["Git Nav.AppImage.sig", `${platform}-appimage-signature`],
      ["Git Nav.deb", `${platform}-deb`],
      ["Git Nav.deb.sig", `${platform}-deb-signature`],
      ["Git Nav.rpm", `${platform}-rpm`],
      ["Git Nav.rpm.sig", `${platform}-rpm-signature`],
    ])
  }

  for (const platform of ["win32-arm64", "win32-x64"]) {
    await writeArtifacts(artifactsDirectory, platform, [
      ["Git Nav.exe", `${platform}-exe`],
      ["Git Nav.exe.sig", `${platform}-exe-signature`],
    ])
  }
}

async function writeArtifacts(
  artifactsDirectory: string,
  platform: string,
  files: [string, string][]
) {
  const directory = join(artifactsDirectory, `installer-${platform}`)
  await mkdir(directory, { recursive: true })
  await Promise.all(
    files.map(([file, contents]) => writeFile(join(directory, file), contents))
  )
}
