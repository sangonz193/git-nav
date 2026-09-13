import { REPOSITORY } from "@/lib/site"

export function SiteHeader() {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4 py-6">
      <a className="flex items-center gap-2.5 font-medium" href="/">
        <img
          alt=""
          className="size-7 rounded-md"
          height={28}
          src="/icon.svg"
          width={28}
        />
        Git Nav
      </a>
      <nav
        aria-label="Main"
        className="flex items-center gap-5 text-sm text-muted-foreground sm:gap-6"
      >
        <a className="transition-colors hover:text-foreground" href="/guides">
          Guides
        </a>
        <a className="transition-colors hover:text-foreground" href="/download">
          Download
        </a>
        <a
          className="transition-colors hover:text-foreground"
          href={REPOSITORY}
        >
          GitHub
        </a>
      </nav>
    </header>
  )
}
