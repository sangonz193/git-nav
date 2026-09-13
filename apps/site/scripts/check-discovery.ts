import assert from "node:assert/strict"
import { SITE_URL } from "../lib/site"

const base = new URL(process.argv[2] ?? "http://localhost:3000")

async function readPage(path: string, userAgent = "Mozilla/5.0") {
  const response = await fetch(new URL(path, base), {
    headers: { "user-agent": userAgent },
    redirect: "error",
  })
  assert.equal(response.status, 200, `${path}: HTTP status`)
  assert(
    !response.headers.get("x-robots-tag")?.includes("noindex"),
    `${path}: X-Robots-Tag`,
  )
  const values = new Map<string, string[]>()
  const links = new Set<string>()
  const ids = new Set<string>()
  const data = new Array<string>()
  let title = ""
  let headings = 0
  let main = 0

  await new HTMLRewriter()
    .on("title", {
      text: (chunk) => {
        title += chunk.text
      },
    })
    .on("h1", {
      element: () => {
        headings += 1
      },
    })
    .on("main", {
      element: () => {
        main += 1
      },
    })
    .on("meta, link[rel=canonical]", {
      element(element) {
        const key =
          element.getAttribute("name") ??
          element.getAttribute("property") ??
          element.getAttribute("rel")
        const value =
          element.getAttribute("content") ?? element.getAttribute("href")
        if (key && value) values.set(key, [...(values.get(key) ?? []), value])
      },
    })
    .on("[id]", {
      element(element) {
        const id = element.getAttribute("id")!
        assert(!ids.has(id), `${path}: duplicate id ${id}`)
        ids.add(id)
      },
    })
    .on("a[href]", {
      element: (element) => {
        links.add(element.getAttribute("href")!)
      },
    })
    .on("img", {
      element(element) {
        assert(element.hasAttribute("alt"), `${path}: image missing alt`)
        assert(
          element.hasAttribute("width") && element.hasAttribute("height"),
          `${path}: image dimensions`,
        )
      },
    })
    .on('script[type="application/ld+json"]', {
      element: () => {
        data.push("")
      },
      text: (chunk) => {
        data[data.length - 1] += chunk.text
      },
    })
    .transform(response)
    .text()

  assert(title.includes("Git Nav"), `${path}: title`)
  assert.equal(headings, 1, `${path}: one H1 in server HTML`)
  assert.equal(main, 1, `${path}: one main landmark`)
  for (const key of [
    "description",
    "canonical",
    "og:title",
    "og:description",
    "og:url",
    "og:image",
    "twitter:card",
    "twitter:title",
    "twitter:description",
    "twitter:image",
  ]) {
    assert.equal(values.get(key)?.length, 1, `${path}: one ${key}`)
  }
  assert(
    ![...(values.get("robots") ?? []), ...(values.get("googlebot") ?? [])].some(
      (value) => /noindex|nosnippet|nofollow/.test(value),
    ),
    `${path}: indexing and snippets allowed`,
  )
  const canonical = new URL(values.get("canonical")![0])
  assert.equal(canonical.origin, SITE_URL, `${path}: production canonical`)
  assert.equal(
    canonical.pathname,
    new URL(path, base).pathname,
    `${path}: self canonical`,
  )
  assert.equal(
    canonical.search,
    "",
    `${path}: canonical drops tracking parameters`,
  )
  assert.equal(
    new URL(values.get("og:url")![0]).href,
    canonical.href,
    `${path}: Open Graph URL`,
  )
  assert.equal(values.get("og:title")![0], title, `${path}: Open Graph title`)
  assert.equal(values.get("twitter:title")![0], title, `${path}: Twitter title`)
  for (const json of data) {
    const parsed = JSON.parse(json)
    assert.equal(
      parsed["@context"],
      "https://schema.org",
      `${path}: JSON-LD context`,
    )
  }
  return {
    title,
    description: values.get("description")![0],
    links,
    ids,
    image: values.get("og:image")![0],
  }
}

const sitemapResponse = await fetch(new URL("/sitemap.xml", base))
assert.equal(sitemapResponse.status, 200, "sitemap is served")
const sitemap = await sitemapResponse.text()
const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
  (match) => new URL(match[1]),
)
assert(urls.length > 3, "sitemap includes guides")
assert(
  urls.every((url) => url.origin === SITE_URL && !url.search && !url.hash),
  "sitemap contains canonical production URLs",
)
const paths = urls.map((url) => url.pathname)
assert.equal(new Set(paths).size, paths.length, "sitemap URLs are unique")
const pages = new Map(
  await Promise.all(
    paths.map(async (path) => [path, await readPage(path)] as const),
  ),
)
assert.equal(
  new Set([...pages.values()].map((page) => page.title)).size,
  pages.size,
  "page titles are unique",
)
assert.equal(
  new Set([...pages.values()].map((page) => page.description)).size,
  pages.size,
  "descriptions are unique",
)
const linkedPaths = new Set<string>(["/"])
for (const [path, page] of pages) {
  for (const href of page.links) {
    const target = new URL(href, new URL(path, base))
    if (target.origin !== base.origin && target.origin !== SITE_URL) continue
    const linkedPage = pages.get(target.pathname)
    assert(
      linkedPage,
      `${path}: linked page ${target.pathname} exists in sitemap`,
    )
    linkedPaths.add(target.pathname)
    if (target.hash)
      assert(
        linkedPage.ids.has(decodeURIComponent(target.hash.slice(1))),
        `${path}: anchor ${href} exists`,
      )
  }
  await readPage(`${path}?utm_source=discovery-check`)
}
assert(
  paths.every((path) => linkedPaths.has(path)),
  "every sitemap page has an internal link",
)

for (const url of new Set([...pages.values()].map((page) => page.image))) {
  const image = new URL(url)
  const response = await fetch(new URL(image.pathname + image.search, base))
  assert.equal(response.status, 200, "social image is served")
  assert(
    response.headers.get("content-type")?.startsWith("image/"),
    "social image content type",
  )
}

const robotsResponse = await fetch(new URL("/robots.txt", base))
assert.equal(robotsResponse.status, 200, "robots.txt is served")
const robots = await robotsResponse.text()
assert.match(robots, /User-Agent: \*\s+Allow: \/\s/i)
assert.match(robots, /Sitemap: https:\/\/git-nav\.dev\/sitemap\.xml/)
assert(!/Disallow:\s*\S/i.test(robots), "public pages remain crawlable")
for (const userAgent of [
  "Googlebot",
  "bingbot",
  "OAI-SearchBot",
  "Claude-SearchBot",
  "PerplexityBot",
]) {
  const page = await readPage(
    "/guides/delete-squash-merged-branches",
    userAgent,
  )
  assert.equal(
    page.title,
    pages.get("/guides/delete-squash-merged-branches")!.title,
    `${userAgent}: same page`,
  )
}
for (const path of ["/not-a-page", "/guides/not-a-guide"]) {
  const response = await fetch(new URL(path, base))
  assert.equal(response.status, 404, `${path}: unknown routes return 404`)
  assert.match(
    await response.text(),
    /name="robots" content="noindex"/,
    `${path}: unknown routes are not indexed`,
  )
}
console.log(
  `Checked ${pages.size} pages: server HTML, metadata, social images, sitemap, internal links, anchors, query canonicals, crawler responses and 404s.`,
)
