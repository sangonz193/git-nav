import type { ResolvingMetadata } from "next"
import { notFound } from "next/navigation"
import { GuideLinks } from "@/components/guide-links"
import { StructuredData } from "@/components/structured-data"
import { guides } from "@/lib/guides"
import { pageMetadata, SITE_URL } from "@/lib/site"
import { guideContent } from "./content"

export const dynamicParams = false

export function generateStaticParams() {
  return guides.map((guide) => ({ slug: guide.slug }))
}

export async function generateMetadata(
  {
    params,
  }: {
    params: Promise<{ slug: string }>
  },
  parent: ResolvingMetadata,
) {
  const { slug } = await params
  const guide = guides.find((entry) => entry.slug === slug)
  if (!guide) notFound()

  return pageMetadata({ ...guide, path: `/guides/${guide.slug}` }, parent)
}

export default async function Guide({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const guide = guides.find((entry) => entry.slug === slug)
  if (!guide) notFound()

  const url = `${SITE_URL}/guides/${guide.slug}`
  const updated = new Intl.DateTimeFormat("en", {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(new Date(guide.updated))

  return (
    <main className="mx-auto max-w-5xl pt-10 sm:pt-16" id="main-content">
      <StructuredData
        data={{
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "TechArticle",
              "@id": `${url}#article`,
              headline: guide.title,
              description: guide.description,
              image: `${SITE_URL}${guide.image}`,
              dateModified: guide.updated,
              author: {
                "@type": "Organization",
                name: "Git Nav",
                url: SITE_URL,
              },
              mainEntityOfPage: url,
              inLanguage: "en",
              about: { "@id": `${SITE_URL}/#software` },
            },
            {
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
                  name: "Guides",
                  item: `${SITE_URL}/guides`,
                },
                {
                  "@type": "ListItem",
                  position: 3,
                  name: guide.title,
                  item: url,
                },
              ],
            },
          ],
        }}
      />
      <nav
        aria-label="Breadcrumb"
        className="flex flex-wrap gap-2 text-sm text-muted-foreground"
      >
        <a className="hover:text-foreground" href="/">
          Git Nav
        </a>
        <span aria-hidden="true">/</span>
        <a className="hover:text-foreground" href="/guides">
          Guides
        </a>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{guide.title}</span>
      </nav>
      <article className="mt-10">
        <header className="max-w-3xl">
          <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            {guide.title}
          </h1>
          <p className="mt-5 text-sm text-muted-foreground">
            By Git Nav · Updated <time dateTime={guide.updated}>{updated}</time>
          </p>
        </header>
        <div className="guide-content mt-8">{guideContent[guide.slug]}</div>
      </article>
      <section className="mt-16 rounded-xl border border-border bg-card p-6 sm:p-8">
        <h2 className="text-2xl font-semibold tracking-tight">
          Try it in Git Nav
        </h2>
        <p className="mt-3 text-muted-foreground">
          A free, open-source Git client for macOS, Windows and Linux. Open a
          local repository and keep working alongside your terminal.
        </p>
        <a
          className="mt-5 inline-flex rounded-lg bg-foreground px-5 py-3 font-medium text-background"
          href="/download"
        >
          Download Git Nav
        </a>
      </section>
      <section className="mt-16" aria-labelledby="related-guides">
        <h2 className="mb-6 text-2xl font-semibold" id="related-guides">
          Related guides
        </h2>
        <GuideLinks except={guide.slug} />
      </section>
    </main>
  )
}
