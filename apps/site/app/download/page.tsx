import type { ResolvingMetadata } from "next"
import { CopyCommand } from "@/components/copy-command"
import { DownloadCta } from "@/components/download-cta"
import { StructuredData } from "@/components/structured-data"
import { latestDownloads, RELEASES } from "@/lib/downloads"
import { PACKAGE, REPOSITORY, SITE_URL, pageMetadata } from "@/lib/site"

export function generateMetadata(_: unknown, parent: ResolvingMetadata) {
  return pageMetadata(
    {
      title: "Download Git Nav for macOS, Windows and Linux",
      description:
        "Download the free, open-source Git Nav desktop client. Get macOS, Windows and Linux installers, or install from npm and open a repository with git nav.",
      path: "/download",
    },
    parent,
  )
}

export default async function Download() {
  const platforms = await latestDownloads()

  return (
    <main className="mx-auto max-w-5xl pt-12 sm:pt-20" id="main-content">
      <StructuredData
        data={{
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: [
            {
              "@type": "ListItem",
              position: 1,
              name: "Git Nav",
              item: `${SITE_URL}/`,
            },
            {
              "@type": "ListItem",
              position: 2,
              name: "Download",
              item: `${SITE_URL}/download`,
            },
          ],
        }}
      />
      <nav
        aria-label="Breadcrumb"
        className="mb-8 flex gap-2 text-sm text-muted-foreground"
      >
        <a className="hover:text-foreground" href="/">
          Git Nav
        </a>
        <span aria-hidden="true">/</span>
        <span aria-current="page">Download</span>
      </nav>
      <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
        Download Git Nav
      </h1>
      <p className="mt-6 max-w-2xl text-lg text-pretty text-muted-foreground">
        A free, open-source Git GUI for macOS, Windows and Linux. Explore the
        graph, compare branches, stage changes and commit to your local
        repositories.
      </p>
      <div className="mt-8">
        <DownloadCta platforms={platforms} />
      </div>

      <section className="mt-16" aria-labelledby="installers">
        <h2 className="text-2xl font-semibold tracking-tight" id="installers">
          Desktop installers
        </h2>
        <p className="mt-4 max-w-2xl text-muted-foreground">
          Choose your operating system and processor. The desktop app requires
          Git on your PATH and updates itself from signed releases.
        </p>
        <div className="mt-8 grid gap-5 md:grid-cols-3">
          {platforms.map((platform) => (
            <section
              className="rounded-xl border border-border bg-card p-6"
              id={platform.key}
              key={platform.key}
            >
              <h3 className="text-xl font-medium">{platform.name}</h3>
              <ul className="mt-5 space-y-3">
                {platform.builds.map((build) => (
                  <li key={build.label}>
                    <a
                      className="text-sm underline underline-offset-4 hover:text-muted-foreground"
                      href={build.url}
                    >
                      {build.label}
                    </a>
                  </li>
                ))}
                {platform.builds.length === 0 && (
                  <li>
                    <a
                      className="text-sm underline underline-offset-4"
                      href={RELEASES}
                    >
                      View {platform.name} installers on GitHub Releases
                    </a>
                  </li>
                )}
              </ul>
              <p className="mt-6 text-sm text-muted-foreground">
                {platformDetails[platform.key]}
              </p>
            </section>
          ))}
        </div>
        <p className="mt-6 text-sm text-muted-foreground">
          <a className="underline underline-offset-4" href={RELEASES}>
            Release history and all assets
          </a>
        </p>
      </section>

      <section className="mt-16" aria-labelledby="npm">
        <h2 className="text-2xl font-semibold tracking-tight" id="npm">
          Install from npm
        </h2>
        <p className="mt-4 max-w-2xl text-muted-foreground">
          With Node.js 20 or later, npm and Git installed, run:
        </p>
        <div className="mt-5 max-w-xl space-y-3">
          <CopyCommand command="npm install --global git-nav" />
          <CopyCommand command="git nav ." />
        </div>
        <p className="mt-5 max-w-2xl text-muted-foreground">
          The package installs the launcher and native binary for your platform.
          Run <code className="font-mono text-foreground">git nav .</code>{" "}
          inside an existing repository, or pass the path to a repository or
          worktree.
        </p>
        <p className="mt-4 text-sm text-muted-foreground">
          <a className="underline underline-offset-4" href={PACKAGE}>
            View the npm package
          </a>
        </p>
      </section>

      <section className="mt-16" aria-labelledby="first-repository">
        <h2
          className="text-2xl font-semibold tracking-tight"
          id="first-repository"
        >
          Open your first repository
        </h2>
        <p className="mt-4 max-w-2xl text-muted-foreground">
          Open a local repository in the desktop app or launch it from its
          directory. Git Nav uses your existing Git repositories. GitHub pull
          request state is optional and reads through an installed,
          authenticated{" "}
          <a
            className="text-foreground underline underline-offset-4"
            href="https://cli.github.com"
          >
            gh CLI
          </a>
          .
        </p>
        <p className="mt-4 max-w-2xl text-muted-foreground">
          Start with{" "}
          <a
            className="text-foreground underline underline-offset-4"
            href="/guides/compare-git-branches"
          >
            comparing branches
          </a>{" "}
          or{" "}
          <a
            className="text-foreground underline underline-offset-4"
            href="/guides/stage-and-commit"
          >
            staging your first commit
          </a>
          .
        </p>
      </section>

      <section className="mt-16" aria-labelledby="license">
        <h2 className="text-2xl font-semibold tracking-tight" id="license">
          Free and open source
        </h2>
        <p className="mt-4 max-w-2xl text-muted-foreground">
          Git Nav is free to download and use under the{" "}
          <a
            className="text-foreground underline underline-offset-4"
            href={`${REPOSITORY}/blob/main/LICENSE`}
          >
            MIT license
          </a>
          . The{" "}
          <a
            className="text-foreground underline underline-offset-4"
            href={REPOSITORY}
          >
            source code
          </a>{" "}
          and{" "}
          <a
            className="text-foreground underline underline-offset-4"
            href={`${REPOSITORY}/issues`}
          >
            issue tracker
          </a>{" "}
          are on GitHub.
        </p>
      </section>
    </main>
  )
}

const platformDetails = {
  mac: "DMG installers for Apple silicon (M-series) and Intel Macs. The app is signed and notarized.",
  windows:
    "EXE installers for x64 and arm64 devices. The installer is not signed yet. SmartScreen may require More info, then Run anyway on first launch.",
  linux:
    "AppImage, deb and rpm packages for x64 and arm64. Choose the format for your distribution and processor.",
}
