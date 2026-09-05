import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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
        `/${platform}-git-nav.AppImage`
      )
      expect(manifest.platforms[`${target}-deb`]).toEqual({
        signature: `${platform}-deb-signature`,
        url: `https://github.com/sangonz193/git-nav/releases/download/v1.2.3/${platform}-git-nav.deb`,
      })
      expect(manifest.platforms[`${target}-rpm`]).toEqual({
        signature: `${platform}-rpm-signature`,
        url: `https://github.com/sangonz193/git-nav/releases/download/v1.2.3/${platform}-git-nav.rpm`,
      })
      expect(
        await readFile(
          join(releaseDirectory, `${platform}-git-nav.deb`),
          "utf8"
        )
      ).toBe(`${platform}-deb`)
      expect(
        await readFile(
          join(releaseDirectory, `${platform}-git-nav.rpm`),
          "utf8"
        )
      ).toBe(`${platform}-rpm`)
    }
  })
})

async function createArtifacts(artifactsDirectory: string) {
  for (const platform of ["darwin-arm64", "darwin-x64"]) {
    await writeArtifacts(artifactsDirectory, platform, [
      ["git-nav.app.tar.gz", `${platform}-app`],
      ["git-nav.app.tar.gz.sig", `${platform}-app-signature`],
      ["git-nav.dmg", `${platform}-dmg`],
    ])
  }

  for (const platform of ["linux-arm64", "linux-x64"]) {
    await writeArtifacts(artifactsDirectory, platform, [
      ["git-nav.AppImage", `${platform}-appimage`],
      ["git-nav.AppImage.sig", `${platform}-appimage-signature`],
      ["git-nav.deb", `${platform}-deb`],
      ["git-nav.deb.sig", `${platform}-deb-signature`],
      ["git-nav.rpm", `${platform}-rpm`],
      ["git-nav.rpm.sig", `${platform}-rpm-signature`],
    ])
  }

  for (const platform of ["win32-arm64", "win32-x64"]) {
    await writeArtifacts(artifactsDirectory, platform, [
      ["git-nav.exe", `${platform}-exe`],
      ["git-nav.exe.sig", `${platform}-exe-signature`],
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
