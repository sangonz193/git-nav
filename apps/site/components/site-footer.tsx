import { PACKAGE, REPOSITORY } from "@/lib/site"
import { RELEASES } from "@/lib/downloads"

export function SiteFooter() {
  return (
    <footer className="mt-28 flex flex-wrap items-center justify-between gap-4 border-t border-border py-8 text-sm text-muted-foreground">
      <span>
        <a
          className="hover:text-foreground"
          href={`${REPOSITORY}/blob/main/LICENSE`}
        >
          MIT licensed.
        </a>{" "}
        Built by Santiago González.
      </span>
      <nav aria-label="Footer" className="flex flex-wrap items-center gap-6">
        <a className="transition-colors hover:text-foreground" href="/guides">
          Guides
        </a>
        <a className="transition-colors hover:text-foreground" href="/download">
          Download
        </a>
        <a className="transition-colors hover:text-foreground" href={PACKAGE}>
          npm
        </a>
        <a className="transition-colors hover:text-foreground" href={RELEASES}>
          Releases
        </a>
        <a
          className="transition-colors hover:text-foreground"
          href={REPOSITORY}
        >
          Source
        </a>
      </nav>
    </footer>
  )
}
