import { guides } from "@/lib/guides"
import { SITE_URL } from "@/lib/site"

export default function sitemap() {
  return [
    ...["/", "/download", "/guides"].map((path) => ({
      url: `${SITE_URL}${path}`,
    })),
    ...guides.map((guide) => ({
      url: `${SITE_URL}/guides/${guide.slug}`,
      lastModified: guide.updated,
    })),
  ]
}
