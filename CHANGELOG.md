# Changelog

## Unreleased

Traffic: every site's visitors and search in one place, and the first version on npm.

- **On npm as `@malha/cli`.** npm refused the unscoped name `malha` as too similar to `mocha` and `hasha`, so the package lives in the `malha` organization. The command is still `malha`: `npm install -g @malha/cli`, or `npx @malha/cli <command>`. Plugin types are `@malha/cli/plugin`.
- The **Traffic** tab: visitors, pageviews, search clicks and impressions with their change against the previous period; every site with its daily trend; top search queries, referrers and pages; sources that could not be read. The app panel shows the app's own trend, pages and queries.
- `malha analytics refresh` fetches traffic into `.malha/analytics.json`; `malha dev` refreshes it every 6 hours, and `malha build` embeds it (`--no-analytics` leaves it out). `malha analytics` prints it.
- `malha analytics detect` finds the trackers on each app's pages (Umami, GA4, Tag Manager, PostHog) and proposes its `analytics` sources, which plugins match to properties and projects; what no page showed is matched by address, and what no app claims is listed.
- New plugins: `umami` (cloud or self-hosted, Umami 2 and 3, with an API key on either or a login; websites also matched to apps by domain), `google` (GA4 and Search Console with one read-only service account, its token signed in the sandbox), `posthog` (cloud or self-hosted, counted per app hostname, one key per account when your projects are spread over several).
- An app with several sites (whitelabels) can have a source per site; its numbers add them up, Search Console properties included. `refresh` names pageviews on hostnames no app lists, and PostHog projects that collect no pageviews.
- The `cloudflare` plugin also reads traffic: visitors and page views per domain, for apps no tracker measures, so every proxied site has numbers.
- New checks: `traffic-drop` (by half, by four fifths, or none for two days; search clicks too), `analytics-error`, `analytics-stale`.
- Periods: every refresh fetches the last 7, 30 and 90 days; `--days N` and `--from`/`--to` fetch others, and `malha dev` fetches any range from the page: a calendar with shortcuts, or drag across a chart. The period and the site are in the address.
- A page for each site: sessions, pages per visit, bounce rate and visit length; a chart against the previous period; pages, referrers, countries, devices, browsers and operating systems; Search Console queries and pages with clicks, impressions, click rate and position. The overview gets a chart for all sites, and countries and devices.
- Links that open each source in its own dashboard, built by Malha from the ids, not by plugins.
- Apps take `analytics:` in the topology. Plugins can export `analytics()` and `link()`, and a fetch pattern's host can be `{options.<key>}`, filled from `malha.plugins.json` and approved as filled in.

## 0.5.0

Open source. The first version in this public repository.

- MIT license.
- Set up for npm (it was `@jnettome/malha`, on GitHub Packages). Releases publish from GitHub Actions with npm trusted publishing and provenance; the first one on npm is 0.6.0, as `@malha/cli`.
- Plugin types moved from `@jnettome/malha/plugin` (in 0.6.0 they are `@malha/cli/plugin`).
- Every example in the docs uses the fictional Acme setup.

## 0.4.0

Checks and alerts, and domains as plugins. **Breaking:** `malha domains sync` is gone; use the `porkbun` and `cloudflare` plugins (below), which take the same credentials. The old command says so.

- `malha check`: what needs a person, by area. Domains expiring (critical within 7 days when in use) or untracked or not renewing; nodes at 80% and 95% of `max_pods`, or degraded; databases on one node; critical vulnerabilities from the last scan, one per advisory across repos; a stale scan. Exits 1 on critical findings (`--fail-on`), `--json` for scripts, `--live` for the cluster's numbers right now.
- `accepted:` in the topology records findings you live with, with a reason and an optional end date.
- `malha check --notify` announces what is new or worse since the last notice, and what was resolved, through notifier plugins; it remembers what was sent only once a notifier confirms. `--digest` sends everything open.
- New plugins: `discord` and `slack` (notifiers), `porkbun` (`sync`), `cloudflare` (`zones`, and `records`, which maps DNS records to machines, proposes hostnames for apps and links for machines, and reports records that point at retired or unknown addresses).
- Plugins: a `notify` capability; changes can `set` `meta.*`, `domains.checked` and `domains.sources` from the top of the file; new items go in order in a list sorted by id; no question for an unset environment variable or a declared file that does not exist.
- `docs/checks.md`, with a daily GitHub Actions workflow and a systemd timer.

## 0.3.1

- `malha kubernetes import` also matches an app without `namespace` to a namespace whose ingresses serve hostnames the app already lists. An app whose id differs from its namespace (`shop` in `shop-prod`) is no longer drafted a second time.

## 0.3.0

- An app's `namespace` can be a list, for an app that spans several namespaces (the app and its Redis, a second instance). The `kubernetes` plugin counts pods and hostnames across all of them, and no longer proposes the others as new apps.

## 0.2.0

Plugins.

- `malha plugin add | list | allow | revoke | remove | log | new`, and `malha <plugin> <command>` for any plugin listed in `malha.plugins.json` next to the topology file.
- Plugins run sandboxed: a separate Node process under the permission model that can read only its own folder, with an empty environment and the network cut by bubblewrap, `unshare`, `sandbox-exec` or Node's own network permission (each proven by a self-test), plus a JavaScript lockdown everywhere.
- Every program, URL, file or environment variable a plugin wants must be declared in its `malha-plugin.json`, and is asked about (yes, yes and don't ask again, or no) in the terminal, or in the browser during `malha dev`. Approvals are per person, tied to the plugin's code hash, and logged in `.malha/plugins.log`.
- Plugins propose changes instead of writing: Malha edits the YAML text in place, in the style around each change, checks the result, shows the diff, and writes on a yes. `--dry-run`, `--yes`, or choose which changes to keep.
- Live plugins refresh the viewer during `malha dev`: live CPU, memory, pods and status replace the sampled values, with a live badge in the header. `--no-plugins` turns them off.
- The `kubernetes` plugin: `malha kubernetes import` proposes node usage and capacity, new nodes, pods per app, ingress hostnames and missing domains; its live data shows every node's CPU, memory, pods and readiness.
- Types for plugin authors as `@jnettome/malha/plugin`; `docs/plugins.md`.
- `docs/releasing.md` and `npm run release`.

Fixes.

- `malha dev` printed the port it asked for, not the one it got, when that port was taken.

## 0.1.0

First version. Extracted from the infrastructure map kept in a Kubernetes repo, with its data taken out and every assumption about that setup removed.

- `malha init`, `dev`, `validate`, `build`, `scan`, `domains sync`, `schema`.
- Six tabs: Topology, Map, Fleet, Products, Domains, Security.
- The viewer ships prebuilt and loads its data at run time. `dev` serves it with live reload; `build` embeds it in a static site.
- Domain sync adapters for Porkbun (registrar) and Cloudflare (DNS).
- The Acme example, unit tests, browser tests, and CI and release workflows for GitHub Actions and GitHub Packages.
