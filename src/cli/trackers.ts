import type { Trackers } from '../core/analytics.ts'
import type { Topology } from '../core/types.ts'

// Which analytics an app's public pages load. Reads the home page of each app, then its own
// scripts (many apps start analytics from a bundle, not the HTML), and picks out tracker ids.
// Malha does this itself, not a plugin: it only ever requests the apps' own public pages.

const UA = 'malha (+https://github.com/jnettome/malha)'
const MAX_PAGE = 3 * 1024 * 1024
const MAX_SCRIPTS = 30
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

async function get(url: string) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/javascript,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return undefined
    const text = await res.text()
    return { url: res.url || url, text: text.length > MAX_PAGE ? text.slice(0, MAX_PAGE) : text }
  } catch {
    return undefined
  }
}

/** Tracker ids in one page or script. `base` resolves relative script URLs. */
export function scan(text: string, base: string) {
  const found = { umami: [] as Trackers['umami'], ga4: new Set<string>(), gtm: new Set<string>(), posthog: [] as Trackers['posthog'] }
  // Umami: <script src=".../script.js" data-website-id="…">, attributes in either order, or a bundle that sets them.
  for (const m of text.matchAll(/<script\b[^>]*>/gi)) {
    const tag = m[0]
    const id = tag.match(new RegExp(`data-website-id=["'](${UUID})["']`, 'i'))?.[1]
    const src = tag.match(/\bsrc=["']([^"']+)["']/i)?.[1]
    if (id && src) found.umami.push({ website: id, script: new URL(src, base).href })
  }
  for (const m of text.matchAll(new RegExp(`["'](https?:\\/\\/[^"'\\s]+\\/(?:script|umami)\\.js)["'][^]{0,300}?(?:data-website-id|websiteId)["']?\\s*[:=,]\\s*["'](${UUID})`, 'gi')))
    found.umami.push({ website: m[2], script: m[1] })
  // GA4: only ids in the gtag loader URL, a gtag config call, or a named measurement-id setting
  // (Next's gaId, measurementId, …), so stray "G-…" strings in text or code don't count.
  for (const m of text.matchAll(/googletagmanager\.com\/gtag\/js\?id=(G-[A-Z0-9]{6,12})\b/g)) found.ga4.add(m[1])
  for (const m of text.matchAll(/gtag\(\s*["']config["']\s*,\s*["'](G-[A-Z0-9]{6,12})["']/g)) found.ga4.add(m[1])
  for (const m of text.matchAll(/["']?(?:measurement_?id|gaId|ga_?id|tracking_?id|GA_MEASUREMENT_ID)["']?\s*[:=]\s*["'](G-[A-Z0-9]{6,12})["']/gi)) found.ga4.add(m[1])
  for (const m of text.matchAll(/googletagmanager\.com\/(?:gtm\.js|ns\.html)\?id=(GTM-[A-Z0-9]{4,10})\b/g)) found.gtm.add(m[1])
  // PostHog: the project key, and where it sends events.
  const hosts = [...text.matchAll(/["']?api_host["']?\s*:\s*["'](https?:\/\/[^"'\s]+)["']/g)].map((m) => m[1])
  for (const m of new Set([...text.matchAll(/\b(phc_[A-Za-z0-9]{30,64})\b/g)].map((x) => x[1]))) found.posthog.push({ key: m, host: hosts[0] })
  return found
}

/** Up to MAX_SCRIPTS scripts from the page's own origin. */
const ownScripts = (html: string, base: string) => {
  const origin = new URL(base).origin
  const urls = new Set<string>()
  for (const m of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
    try {
      const u = new URL(m[1], base)
      if (u.origin === origin) urls.add(u.href)
    } catch {
      // not a URL
    }
  }
  return [...urls].slice(0, MAX_SCRIPTS)
}

/** The hostnames worth loading for an app: no wildcards, the bare domain and www first. */
export const pageHosts = (domains: string[] = []) =>
  domains.filter((d) => !d.includes('*')).sort((a, b) => a.split('.').length - b.split('.').length)

export async function findTrackers(t: Topology, log: (line: string) => void = () => undefined): Promise<Trackers[]> {
  const out: Trackers[] = []
  for (const app of t.apps ?? []) {
    const hostnames = pageHosts(app.domains)
    if (!hostnames.length) continue
    const result: Trackers = { app: app.id, hostnames, umami: [], ga4: [], gtm: [], posthog: [] }
    const seen = { umami: new Set<string>(), ga4: new Set<string>(), gtm: new Set<string>(), posthog: new Set<string>() }
    const add = (found: ReturnType<typeof scan>) => {
      for (const u of found.umami) if (!seen.umami.has(u.website) && seen.umami.add(u.website)) result.umami.push(u)
      for (const g of found.ga4) if (!seen.ga4.has(g) && seen.ga4.add(g)) result.ga4.push(g)
      for (const g of found.gtm) if (!seen.gtm.has(g) && seen.gtm.add(g)) result.gtm.push(g)
      for (const p of found.posthog) if (!seen.posthog.has(p.key) && seen.posthog.add(p.key)) result.posthog.push(p)
    }
    let pages = 0
    for (const host of hostnames.slice(0, 2)) {
      const page = await get(`https://${host}/`)
      if (!page) continue
      pages++
      add(scan(page.text, page.url))
      const scripts = ownScripts(page.text, page.url)
      for (let i = 0; i < scripts.length; i += 6) {
        const batch = await Promise.all(scripts.slice(i, i + 6).map(get))
        for (const s of batch) if (s) add(scan(s.text, s.url))
      }
    }
    log(`${app.id}: ${pages ? [result.umami.length && `Umami ${result.umami.map((u) => u.website.slice(0, 8)).join(', ')}`, result.ga4.length && `GA4 ${result.ga4.join(', ')}`, result.gtm.length && `Tag Manager ${result.gtm.join(', ')}`, result.posthog.length && `PostHog ${result.posthog.length} key(s)`].filter(Boolean).join(' · ') || 'no trackers found' : 'no page answered'}`)
    out.push(result)
  }
  return out
}
