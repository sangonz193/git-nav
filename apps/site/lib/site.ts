import type { Metadata, ResolvingMetadata } from "next"

export const SITE_URL = "https://git-nav.dev"
export const REPOSITORY = "https://github.com/sangonz193/git-nav"
export const PACKAGE = "https://www.npmjs.com/package/git-nav"
export const HOME_TITLE = "Free Git GUI for macOS, Windows and Linux"
export const HOME_HEADLINE =
  "A Git client that hides the commits nobody points at."
export const DESCRIPTION =
  "Free, open-source Git GUI for macOS, Windows and Linux. Explore commit graphs, compare branches, stage and commit, and clean up squash-merged branches."

export async function pageMetadata(
  {
    title,
    description,
    path,
  }: {
    title: string
    description: string
    path: string
  },
  parent: ResolvingMetadata,
) {
  const fullTitle = `${title} | Git Nav`
  const images = (await parent).openGraph?.images

  return {
    title: fullTitle,
    description,
    alternates: { canonical: path },
    openGraph: {
      title: fullTitle,
      description,
      url: path,
      siteName: "Git Nav",
      type: "website",
      images,
    },
    twitter: {
      card: "summary_large_image",
      title: fullTitle,
      description,
      images,
    },
  } satisfies Metadata
}
