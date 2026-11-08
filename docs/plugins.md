# Plugins

A plugin teaches Malha about something it doesn't know: your cluster, your cloud account, a CMDB, a monitoring API. It can do two things:

- **Commands** read the outside world and **propose changes** to `topology.yaml`. You see them as a diff, and nothing is written until you say yes. `malha kubernetes import` drafts nodes, apps and hostnames from a cluster.
- **Live data** refreshes the open viewer while `malha dev` runs. The `kubernetes` plugin shows CPU, memory and pods per node, every 30 seconds.
- **Notifiers** deliver what `malha check --notify` finds. The `discord` and `slack` plugins post it to a channel.
- **Analytics** plugins read traffic for `malha analytics refresh` and the Traffic tab: `umami`, `google` (GA4 and Search Console) and `posthog`.

Plugin code runs in a sandbox, and everything it does outside its own folder is a request that Malha checks against what the plugin declared, then asks you about, the way Claude Code asks before it runs a command.

## Using plugins

```bash
malha plugin add kubernetes infra/topology.yaml        # one that ships with Malha
malha plugin add ./tools/hetzner infra/topology.yaml   # a folder, e.g. in your repo
```

`add` shows what the plugin may do, and asks before adding it to `malha.plugins.json`, next to the topology file. Commit that file: it is how the team shares the project's plugins. For a plugin that is a folder, it also pins the sha256 of the code you reviewed; if the code changes, the plugin stops running until someone reviews it again with `malha plugin add`.

```bash
malha kubernetes import infra/topology.yaml              # run a command; review the diff; yes, no, or choose which
malha kubernetes import infra/topology.yaml --dry-run    # only show the diff
malha kubernetes import infra/topology.yaml -- --no-add  # arguments after -- go to the plugin
malha dev infra/topology.yaml                            # live plugins start with the viewer
```

The first time a plugin wants to do something, Malha asks:

```
  kubernetes wants to run a program
    kubectl get nodes -o json
  Declared in its manifest as: kubectl [--context *] get nodes -o json

  1. Yes
  2. Yes, and don't ask again for kubectl [--context *] get nodes -o json (kubernetes 0.1.0, vvcAljrqi7fs)
  3. No
```

"Yes" lasts for this run (or until `malha dev` stops). "Don't ask again" lasts until the plugin's code changes. In `malha dev`, the question appears in the browser instead, with the same three choices; keys 1, 2 and 3 answer it, Esc says no, and Enter does nothing.

| Command | What it does |
| --- | --- |
| `malha plugin list [file]` | The project's plugins, their commands, and how many of their permissions you allowed for good. |
| `malha plugin allow <name> [file]` | Approve everything a plugin declares, for this version. For CI and scripts, where nobody can answer questions. `--yes` skips the confirmation. |
| `malha plugin revoke <name> [file]` | Forget your approvals; it asks again. |
| `malha plugin remove <name> [file]` | Take it out of `malha.plugins.json`. |
| `malha plugin log [file]` | The last 50 requests plugins made and what was decided. `--plugin <name>` to filter. |
| `malha plugin new <dir>` | Start a plugin (see [Writing a plugin](#writing-a-plugin)). |

Approvals and the log are yours alone: they live in `.malha/` next to the topology file, which is never committed. A teammate who pulls your `malha.plugins.json` is asked for their own approval.

### `malha.plugins.json`

```json
{
  "plugins": {
    "kubernetes": {
      "source": "builtin:kubernetes",
      "options": { "context": "prod", "ignore_namespaces": ["ingress-nginx", "cert-manager"] }
    },
    "hetzner": {
      "source": "./tools/hetzner",
      "integrity": "sha256-…",
      "live": false
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `source` | `builtin:<name>`, or a folder relative to this file. |
| `integrity` | Written by `malha plugin add`. The plugin refuses to run if its folder no longer matches. |
| `options` | Passed to the plugin as `ctx.options`. Each plugin documents its own. |
| `live` | `false` keeps the plugin's live data out of `malha dev`. `malha dev --no-plugins` turns all of it off. |
| `notify` | `false` keeps a notifier out of `malha check --notify`. |

### In CI

Nobody can answer questions in CI, so approve ahead of time, then run without prompts:

```bash
malha plugin allow kubernetes infra/topology.yaml --yes
malha kubernetes import infra/topology.yaml --dry-run    # or --yes to write
```

Without a terminal, any request you have not approved is refused, and writing changes needs `--yes`.

## What keeps plugin code contained

Each run is a fresh Node process, started by Malha and treated as untrusted.

| Layer | What it stops |
| --- | --- |
| Node's permission model | Reading any file outside the plugin's folder (and Malha's small runtime), writing any file, starting processes or workers, native addons, WASI, the inspector. |
| An empty environment | Tokens and paths in your environment variables. A plugin asks for a variable by name. |
| A network block | Any connection of its own. Malha uses the strongest of: bubblewrap (Linux; also its own process namespace, so it cannot signal your processes), `unshare` (Linux), `sandbox-exec` (macOS), Node's network permission (Node 25 and later). Each OS layer is proven by a self-test before it is used. On top of all of them, a JavaScript lockdown takes `net`, `http`, `https`, `tls`, `dgram`, `dns`, `fetch` and `WebSocket` away from plugin code. |
| Malha's checks | Every request (run a program, fetch a URL, read a file, read a variable) must match a pattern in the plugin's manifest; anything else is refused without asking. Then your earlier answers, then a question. |
| Proposals, not writes | A plugin cannot change your files. It returns changes; Malha applies them to the text, checks the result parses to exactly what was proposed and still validates, shows the diff, and writes only on your yes. Changes add and update; they never delete. |
| Limits | 5 minutes per command (60 s per live refresh), not counting time spent waiting for your answer; 512 MB of memory; 2 minutes and 64 MB of output per program; 32 MB per web response; 10 MB per file. |
| Clean output | Escape sequences and control characters are stripped from everything a plugin prints, and its output is held back while a question is on screen, so it cannot fake or hide a prompt. |

`malha plugin add` and `list` say which network block your machine has. To refuse plugins wherever only the JavaScript lockdown is available, set `MALHA_PLUGIN_SANDBOX=strict`.

What the sandbox does **not** do, so you can judge what to approve:

- **A program you let it run is not sandboxed.** `kubectl get nodes -o json` runs as you, with your kubeconfig. Patterns are matched argument by argument, and `*` never matches a flag, so `kubectl get *` cannot become `kubectl get --kubeconfig=/evil`. But a pattern for a shell or an interpreter (`sh`, `bash`, `node`, `python`, `sudo`, `env`, `xargs`…) hands over everything, and `malha plugin add` flags it.
- **A host you let it fetch receives whatever the plugin sends,** including your topology if it may read it. That is why fetch patterns name exact hosts.
- **Plugins that ship with Malha get no special trust.** They run in the same sandbox and ask the same questions.

## Writing a plugin

```bash
malha plugin new tools/hello     # malha-plugin.json, index.js, package.json, README.md
malha plugin add ./tools/hello infra/topology.yaml
malha hello hello infra/topology.yaml
```

Run `malha plugin add` again after every change to the code: the hash changed, so the plugin is blocked until you review it, and your approvals for it reset.

### `malha-plugin.json`

```json
{
  "name": "hello",
  "version": "0.1.0",
  "description": "One sentence about what it does.",
  "main": "index.js",
  "permissions": {
    "exec": ["kubectl [--context *] get nodes -o json"],
    "fetch": ["GET,POST https://api.example.com/v1/*"],
    "files": ["~/.config/example/token"],
    "env": ["EXAMPLE_TOKEN"],
    "topology": "propose"
  },
  "commands": { "sync": "One line for help" },
  "live": { "every": 30, "description": "What the viewer shows" }
}
```

| Field | Meaning |
| --- | --- |
| `name` | Lowercase letters, digits and dashes. It is also the command: `malha <name> <command>`. Malha's own command names are refused. |
| `main` | The entry module, relative to the folder. ES module syntax; add `{ "type": "module" }` in a `package.json`, or use `.mjs`. |
| `permissions.exec` | Programs it may run. The first word is a program on the user's PATH (not a path). Each following word must match one argument exactly; `*` matches one argument that does not start with `-`; `[ ]` makes the words inside optional. |
| `permissions.fetch` | URLs it may request: exact scheme, host and port, `*.` in front of the host for subdomains, `*` in the path for anything. GET and HEAD unless methods are listed in front. Redirects are returned, not followed, so each hop is checked. The whole host may be `{options.<key>}`, for servers each project names (a self-hosted Umami): it is filled from `malha.plugins.json`, one origin or a list of them, nothing but scheme, host and port, and the person approves the filled-in pattern. |
| `permissions.files` | Files outside its folder it may read: absolute or `~/`; `*` within a path segment, `**` across segments. |
| `permissions.env` | Environment variables it may read, by exact name. |
| `permissions.topology` | `none`, `read` (it gets the parsed topology), or `propose` (also returns changes). |
| `commands` | Each command it exports, with a line for help. |
| `live` | Present if it exports `live()`; `every` is seconds between refreshes (5 to 86400). |
| `notify` | Present if it exports `notify()`; `description` is shown when it is added. |
| `analytics` | Present if it exports `analytics()` (and, optionally, `link()`); `providers` lists the ones it reads (`umami`, `ga4`, `posthog`, `search-console`). |

The schema is `schema/plugin.schema.json`; the `$schema` line in the template gives editors autocomplete.

### `index.js`

```js
/** @type {import('malha/plugin').Plugin} */
export default {
  commands: {
    async sync(ctx) {
      const topology = await ctx.topology()
      const res = await ctx.fetch('https://api.example.com/v1/servers', { headers: { authorization: `Bearer ${await ctx.env('EXAMPLE_TOKEN')}` } })
      const servers = await res.json()
      return {
        message: `${servers.length} servers in the account.`,
        changes: servers
          .filter((s) => !topology.nodes.some((n) => n.id === s.name))
          .map((s) => ({ add: 'nodes', item: { id: s.name, name: s.name, kind: 'server', zone: 'servers' }, why: 'in the account, not in the file' })),
      }
    },
  },
  async live(ctx) {
    return { nodes: { web1: { cpu_pct: 12, memory_pct: 40, pods: 31, status: 'active' } } }
  },
}
```

For editor types, add `malha` as a dev dependency of the plugin (`npm install -D malha`); the `@type` comment then checks the whole plugin.

`ctx` is all a plugin has:

| Member | What it is |
| --- | --- |
| `ctx.options` | The plugin's `options` from `malha.plugins.json`. |
| `ctx.args` | Arguments after `--` on the command line. |
| `ctx.today` | Today's date, `YYYY-MM-DD`, in the user's time zone. |
| `ctx.topology()` | The topology as parsed JSON. |
| `ctx.exec(program, args)` | `{ stdout, stderr, code }`. No shell: arguments are passed as they are. A non-zero exit is not an error. |
| `ctx.fetch(url, { method, headers, body })` | A standard `Response`. The global `fetch` is the same function, so libraries that call `fetch` work. |
| `ctx.readFile(path)` | A UTF-8 string. A declared file that does not exist rejects with `code` `MALHA_NOT_FOUND`, without asking anyone. |
| `ctx.env(name)` | The value, or `undefined` when unset (also without asking). |

A refused request rejects with an error whose `code` is `MALHA_DENIED`; a plugin can catch it and carry on with less. `console.log` output appears under the plugin's name.

### Changes

A command returns `{ message?, changes? }`. Each change is one of:

```js
{ add: 'nodes', item: { id: 'w6', name: 'w6', kind: 'worker', zone: 'workers' }, why: 'shown in the diff' }
{ update: 'nodes', id: 'w1', set: { 'usage.pods': 72, 'hardware.max_pods': 110 } }
{ update: 'apps', id: 'shop', set: { pods: { w1: 3, w2: 2 } } }
{ meta: { pods_sampled: ctx.today } }
{ set: { 'domains.checked': ctx.today } }
```

- `add` goes to `providers`, `networks`, `sites`, `zones`, `nodes`, `links`, `apps`, `flows` or `domains` (the domain list). In a list already sorted by id (or name), the new item goes in order; otherwise at the end.
- A change with only `set` works from the top of the file, and reaches `meta.*`, `domains.checked` and `domains.sources`. `meta: {…}` is the same as `set: { 'meta.…': … }`.
- `update` finds the item by `id` (`name` for domains). `set` keys are dotted paths; each value replaces what is at that path, so set `usage.pods` to change one number, or `pods` to replace the whole map.
- Nothing deletes: there is no remove, and `null` is refused. A change that would leave the file invalid stops the whole proposal; a change that names something missing is skipped and reported.

Malha edits only the text it has to, in the style already there: an inline `{ … }` stays inline, a new node is written like the one before it, the blank lines between items stay.

### Live data

`live()` returns `{ nodes: { <node id>: { cpu_pct, memory_pct, pods, status } } }`, every field optional. Unknown node ids and out-of-range values are dropped. The viewer shows these in place of the sampled `usage` and `status` in the file, marks them live, and adds them up in the Pods total. Nothing is written to the file.

### Notifiers

`notify(ctx, report)` gets what `malha check --notify` decided to announce, and returns `{ sent, message }`:

```js
export default {
  async notify(ctx, report) {
    // report.project, report.command ("malha check infra/topology.yaml"), report.open (how many are open),
    // report.findings: [{ id, check, subject, severity: 'critical' | 'warning', level, title, detail }],
    // report.resolved: [{ id, title }], report.digest (true when it is everything open, not what is new)
    const url = await ctx.env('PAGER_WEBHOOK')
    if (!url) return { sent: false, message: 'set PAGER_WEBHOOK' }
    await ctx.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lines: report.findings.map((f) => f.title) }) })
    return { sent: true }
  },
}
```

Declare `"notify": {}` in the manifest, and a `fetch` pattern for exactly the service it posts to. Malha marks findings as announced only when at least one notifier returns `sent: true`.

### Analytics

`analytics(ctx, request)` gets `{ range, previous, timezone, sources }`: whole days ending yesterday, the same number of days before, and the sources it serves, each `{ app, provider, id, host?, hostnames }`. It returns `{ results }`, one per source: `{ app, provider, id, ok, error?, totals, previous, series, top }`, or `search` for Search Console. The shapes are `SourceResult` in `malha/plugin`; Malha keeps only the sources it asked for and well-formed numbers.

`link(ctx, { trackers })` gets what `malha analytics detect` found on each app's pages (Umami website ids and script URLs, GA4 measurement ids, Tag Manager containers, PostHog keys and hosts, and the app's hostnames) and returns `{ sources: [{ app, source }], notes }`: the sources those trackers are, and lines about anything it could not match.

### Dependencies

Malha never runs `npm install` for a plugin: install scripts would run outside the sandbox. Write plain JavaScript, or bundle dependencies into the folder (esbuild or Rollup into one file is simplest). Symlinks are refused, because the permission model would follow them out of the folder, so a pnpm-style `node_modules` will not work.

### Testing

Run commands with `--dry-run` while you work. To test without the real program, put a fake one first on PATH, the way Malha's own tests do for `kubectl` (`tests/fixtures/bin/kubectl`).

### Sharing

Keep the plugin in a folder of your infra repo and add it from there: teammates get the code and the pinned hash with the next pull. A folder far outside the project is stored as an absolute path, which only works on your machine.

## The `kubernetes` plugin

Ships with Malha. It runs only `kubectl config current-context`, and `kubectl get` and `kubectl top` with fixed arguments, against your current kubeconfig context or `options.context`.

**`malha kubernetes import`** proposes:

- for each cluster node in the file: `usage` (CPU and memory from `kubectl top`, pods that are not finished, today's date), `hardware.cpu`, `hardware.memory_gib` (when more than 5% off) and `hardware.max_pods` from capacity, and `status: degraded` when the node is NotReady;
- for each cluster node not in the file: a draft entry, in the zone of a node with the same role, to finish by hand;
- for each app: `pods` per node from its namespaces (summed when `namespace` is a list), and ingress hostnames it does not list yet. An app without `namespace` is matched by the hostnames it lists (a namespace whose ingresses serve one of them), then by its id (ignoring punctuation, so `shop-api` finds `shopapi`), and gets the namespace written down;
- for each namespace with pods that no app claims: a draft app (except `kube-system`, `kube-public`, `kube-node-lease`, `default`, and `options.ignore_namespaces`);
- `meta.kubernetes`, `meta.runtime` and `meta.pods_sampled`;
- for each registered domain an ingress uses that the domain list lacks: a new entry.

It also lists nodes in the file that the cluster lacks; set those to `status: retired` yourself. Pass `-- --no-add` to only update what the file already has.

Nodes are matched by id, then `name`, then `host` (the node name is the host, or its first label), then any address.

**Live data:** CPU and memory from `kubectl top nodes` (when metrics-server works), pods per node, and `degraded` for NotReady nodes, every 30 seconds.

| Option | Meaning |
| --- | --- |
| `context` | A kubeconfig context to use instead of the current one. |
| `ignore_namespaces` | Namespaces that are not apps (`ingress-nginx`, `cert-manager`…), never proposed as new apps. |

## The `porkbun` and `cloudflare` plugins

They keep `domains` in step with the registrar and the DNS host, propose changes as a diff, and never remove an entry. Each adds itself under `providers` if it is missing, and sets `domains.checked`. `options.provider` changes the provider id they write (default `porkbun` and `cloudflare`).

| Command | Proposes |
| --- | --- |
| `malha porkbun sync` | `registrar`, `expires` and `auto_renew` for every domain in the Porkbun account; new entries for the ones the file lacks. Lists domains the file says are at Porkbun that the account no longer has. |
| `malha cloudflare zones` | `dns` and `plan` for every zone in the account; new entries for the ones the file lacks. Lists zones that are not active, and domains the file says are on this Cloudflare that are not. |
| `malha cloudflare records` | Follows every A, AAAA and CNAME record (through CNAME chains) to the machine it reaches. A name no app lists goes to the app with the most trailing labels in common (`beta.shop.acme.example` to the app with `shop.acme.example`), when one app clearly wins; a machine reached with no HTTP link gets one from the `users` node. Reports records that point at retired machines, at addresses no machine has, and app hostnames with no record. |

Credentials: `PORKBUN_API_KEY` and `PORKBUN_SECRET_API_KEY` (or `~/.config/malha/porkbun-api-key` and `porkbun-secret-api-key`; the older `~/.config/porkbun/` paths still work), with API access on for the account. `CLOUDFLARE_API_TOKEN` (or `~/.config/malha/cloudflare-token`), with Zone → Zone → Read, and Zone → DNS → Read for `records`. Each plugin may call only its own API.

## The `discord` and `slack` plugins

Notifiers for `malha check --notify`: the findings by area (at most ten vulnerabilities, then a count), the resolved ones, and the command to see everything. The webhook comes from `DISCORD_WEBHOOK_URL` or `~/.config/malha/discord-webhook` (`SLACK_WEBHOOK_URL`, `~/.config/malha/slack-webhook`), and must be on Discord's (or Slack's) own host. Discord messages are split at 2000 characters and never mention anyone. Setting them up, and running the check daily: [docs/checks.md](checks.md).

## The `umami`, `google` and `posthog` plugins

They read traffic for `malha analytics refresh` and the Traffic tab, and match trackers for `malha analytics detect`. Setup for each, and what their numbers mean: [analytics.md](analytics.md).

| Plugin | Reads | Credentials |
| --- | --- | --- |
| `umami` | Umami Cloud, or your servers (`options.hosts`) | `UMAMI_API_KEY`, or `UMAMI_USERNAME` and `UMAMI_PASSWORD`, or `~/.config/malha/umami.json` per host |
| `google` | GA4 and Search Console | A service account's JSON key: `GOOGLE_SERVICE_ACCOUNT` or `~/.config/malha/google-service-account.json` |
| `posthog` | PostHog Cloud or your instance (`options.hosts`) | `POSTHOG_PERSONAL_API_KEY` or `~/.config/malha/posthog-key` |
