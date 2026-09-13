# Search discovery

Git Nav's public site is `https://git-nav.dev`. The homepage introduces the Git client; the download
page covers platforms and installation; the guides answer specific Git workflow questions. Keep
product claims consistent across these pages, the repository README and the npm package.

## Verify ownership and submit the site

1. Add `git-nav.dev` as a Domain property in [Google Search Console](https://search.google.com/search-console).
   Copy its DNS TXT verification record to the domain's DNS provider and complete verification.
   Keep the record in place. A Domain property includes both hostnames and protocols.
2. After deployment, submit `https://git-nav.dev/sitemap.xml` in the Sitemaps report. Inspect the
   homepage, `/download` and each guide with URL Inspection. Check the live page, the chosen
   canonical and index eligibility, then request indexing for the new pages.
3. Add `https://git-nav.dev` to [Bing Webmaster Tools](https://www.bing.com/webmasters/). Complete an
   ownership verification method offered by the account and submit the same sitemap. Use URL
   Inspection to check the pages, and URL Submission when publishing substantial updates.
4. Confirm that `http://git-nav.dev` and `https://www.git-nav.dev` redirect to the HTTPS apex domain.
   Confirm that public pages are accessible without a login, challenge or `noindex` response header.

[Search Console's setup guide](https://developers.google.com/search/docs/monitor-debug/search-console-start)
describes ownership, indexing and performance reports. Submission helps discovery; indexing depends
on the search engine's assessment of the pages.

## Crawl access and page metadata

`apps/site/app/robots.ts` allows public crawling and advertises the sitemap. This includes search
crawlers using the wildcard rule. Verify access at the hosting firewall as well as in robots.txt;
a successful request with a bot user-agent string alone does not verify access from that bot's network.

[OpenAI's crawler documentation](https://developers.openai.com/api/docs/bots) distinguishes
OAI-SearchBot, used for search, from GPTBot, used for training. Keep search crawling accessible,
including requests from the provider's published IP ranges when configuring firewall rules.
[Google's AI search guidance](https://developers.google.com/search/docs/appearance/ai-features)
requires indexed, snippet-eligible pages and emphasizes textual content, internal links and
structured data that agrees with the page.

Every public page has its own title, description and canonical URL. Social metadata inherits the
generated image URL from the root layout, including its cache hash. The homepage describes Git Nav
with WebSite and SoftwareApplication data; guides include article and breadcrumb data. Add genuine
reviews to structured data only when the corresponding reviews are published on the page.
[Google's app rich-result requirements](https://developers.google.com/search/docs/appearance/structured-data/software-app)
include a rating or review in addition to the app's name and price.

## Publish useful pages

| Page                                    | Search intent                                                      |
| --------------------------------------- | ------------------------------------------------------------------ |
| `/`                                     | Free, open-source Git GUI for macOS, Windows and Linux             |
| `/download`                             | Install Git Nav and choose the right platform build                |
| `/guides/delete-squash-merged-branches` | Why `git branch --merged` misses squash merges and how to clean up |
| `/guides/git-worktrees`                 | Work on several branches in separate directories with a Git GUI    |
| `/guides/compare-git-branches`          | Compare branch tips or use a three-dot diff from the merge base    |
| `/guides/stage-and-commit`              | Understand the index and prepare a commit in a Git GUI             |

Start a guide with the answer, then show a concrete example, the app workflow, relevant limitations
and links to Git's documentation. Use actual app screenshots and descriptive headings. Link new
guides from the guide index, the relevant homepage section and related guides.

Guide metadata lives in `apps/site/lib/guides.ts`; the sitemap and guide listings use that catalog.
Update a guide's `updated` date when its content materially changes. Keep that date aligned with the
visible update date and sitemap. Add a separate page when it answers a distinct question with
substantial original material. Use query data and user questions to decide what to write next.

## Repository and package discovery

Keep the repository's About description and topics aligned with the product:

- Description: `Free, open-source Git GUI for macOS, Windows and Linux. Collapsible commit graph, diffs, worktrees, staging and squash-merged branch cleanup.`
- Website: `https://git-nav.dev`
- Topics: `git`, `git-client`, `git-gui`, `git-worktree`, `git-diff`, `squash-merge`, `tauri`, `rust`, `desktop-app`

The npm manifest sets the product homepage, MIT license and search keywords. Its README links to
installation and workflow guides; these metadata changes reach npm with the next package release.

Use the [Git GUI directory](https://git-scm.com/tools/guis) as a relevant distribution channel.
Its page links to submission instructions. A listing should use the same product name, homepage,
Mac/Windows/Linux platforms, free price, MIT license and an app screenshot. For community posts or
technical articles, demonstrate a specific workflow and link to its guide so readers can try it.

## Measure and maintain

After launch, check indexing first. Once reports have enough data, compare successive 28-day windows:

- Search Console: impressions, clicks, click-through rate and queries by landing page. Separate
  searches for Git Nav from searches describing the problem or category.
- Bing Webmaster Tools: indexing and search traffic, plus the
  [AI Performance report](https://blogs.bing.com/webmaster/February-2026/Introducing-AI-Performance-in-Bing-Webmaster-Tools-Public-Preview)
  for cited URLs and citations across supported AI experiences.
- Vercel Web Analytics: landing pages, referrers and visits to `/download`. Download-page visits
  measure intent; they do not establish that a download or installation completed.
- Search Console's Core Web Vitals report and PageSpeed Insights: loading, layout stability and
  responsiveness, particularly on mobile. Check images and fonts when a regression appears.

Vercel's [custom download/copy events](https://vercel.com/docs/analytics/custom-events) can measure
those actions separately on a plan that supports custom events. Keep event data limited to the
action, page and platform.

For a local production check, run `bun --filter=site run build`, start the site with
`bun --filter=site run start`, then in another terminal run:

```sh
bun --filter=site run check:discovery http://localhost:3000
```

This checks the server-rendered content, metadata, social images, sitemap, links, anchors, tracking
parameter canonicals, crawler responses and missing-page behavior. Verify desktop and mobile
layouts when editing content or page structure.
