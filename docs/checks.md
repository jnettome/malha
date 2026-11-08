# Checks and alerts

`malha check` reads the topology (and the last dependency scan, if there is one) and lists what needs a person. It changes nothing.

```bash
malha check infra/topology.yaml
```

```
Acme: 0 critical, 4 warning(s)

Domains
  warning   acme-old.example expires in 12 days (2026-11-20)
            serves nothing in this map · registrar porkbun

Nodes
  warning   worker-1 runs 94 of 110 pods (85%)
            sampled 2026-10-01; new pods stop scheduling at 110

Databases
  warning   admin-db (Back office) runs on one node, w2
            postgres; offline whenever w2 is
  warning   prometheus (Prometheus + Grafana) runs on one node, w1
            tsdb; offline whenever w1 is
```

It exits 1 when there is a critical finding. `--fail-on warning` also fails on warnings, `--fail-on none` never fails. `--json` prints every finding, for scripts.

## The checks

| Check | Subject | Warning | Critical | Levels |
| --- | --- | --- | --- | --- |
| `domain-expiry` | domain | expires within 30 days | within 7 days, or expired, when it serves something | 30, 14, 7, 1, expired |
| `domain-untracked` | domain | serves something, but has no `expires` | | |
| `domain-no-autorenew` | domain | serves something, `auto_renew: false` | | |
| `domain-unlisted` | domain | an app or machine uses it, it is not in `domains.list` | | |
| `node-degraded` | node id | `status: degraded` in the file | NotReady, live | |
| `pod-pressure` | node id | 80% of `max_pods` | 95% | 80, 95 |
| `single-node-database` | `app/database` | every replica on one node | | |
| `vulnerability` | advisory id | high (with `--vulns high`) | critical | the severity |
| `scan-stale` | `scan` | the last scan is over two weeks old | | each further two weeks |

A domain "serves something" when an app lists one of its hostnames or a machine's `host` is in it. A domain that serves nothing and has expired is not a finding: you most likely let it go (`malha validate` still mentions it).

Vulnerabilities come from `.malha/scan.json`, written by `malha scan`. Each advisory is one finding across every repo that ships it (development-only dependencies don't count), most widespread first. The terminal shows ten; `--json` and the Security tab of `malha dev` have all of them.

## Current numbers: `--live`

The node checks use the sampled `usage` in the file. `--live` asks every live plugin (the `kubernetes` plugin, say) for the numbers right now first, so a full or NotReady node shows up even if the file is a week old. It needs the same approvals as `malha dev`.

## Accepting a finding

Some findings are decisions, not problems. Record them in the topology, with the reason:

```yaml
accepted:
  - { check: single-node-database, subject: admin/admin-db, why: Rebuilt from the nightly dump in minutes. }
  - { check: domain-expiry, subject: acme-old.example, why: The 2019 brand; letting it lapse., until: 2026-12-31 }
  - { check: scan-stale, why: We scan before releases only. }
```

An accepted finding is listed at the end with its reason and never notified. After `until` it is open again. Without `subject`, every finding of that check is accepted.

## Alerts: `--notify`

```bash
malha plugin add discord infra/topology.yaml          # or slack
export DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/…
malha check infra/topology.yaml --notify
```

`--notify` hands what to announce to every notifier plugin in `malha.plugins.json`:

- **New or worse findings.** Each finding is announced once, and again when its level rises: a domain at 30 days, then at 14, 7, 1, and when it expires; a node at 80%, then 95%.
- **Resolved findings:** announced before, gone now (accepted ones leave quietly).
- Nothing when nothing changed.

What was announced is remembered in `.malha/check-state.json`, next to the topology, and only after a notifier confirms it sent the message, so a failed delivery is tried again on the next run (and the command exits 1). `--digest` announces every open finding, whatever was sent before: a weekly summary, say.

| Notifier | Webhook from |
| --- | --- |
| `discord` | `DISCORD_WEBHOOK_URL`, or the URL alone in `~/.config/malha/discord-webhook`. Channel settings → Integrations → Webhooks. Mentions are switched off, whatever a finding says. |
| `slack` | `SLACK_WEBHOOK_URL`, or `~/.config/malha/slack-webhook`. An incoming webhook from a Slack app. |

Each may post only to its own service: a webhook URL on another host is refused. To send findings somewhere else, write a plugin with a `notify(ctx, report)` function ([docs/plugins.md](plugins.md#notifiers)).

## Running it every day

### GitHub Actions

The checks that need only the file (domains, sampled usage, databases) run anywhere. This workflow runs them every morning and posts what is new; it keeps `.malha/check-state.json` between runs in the Actions cache, so each finding is announced once.

```yaml
name: Infra checks
on:
  schedule:
    - cron: '0 11 * * *'     # every day: what is new or worse
    - cron: '30 11 * * 1'    # Mondays: everything open
  workflow_dispatch:

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - run: npm install -g malha
      - uses: actions/cache/restore@v6
        with:
          path: infra/.malha/check-state.json
          key: malha-check-${{ github.run_id }}
          restore-keys: malha-check-
      - run: malha plugin allow discord infra/topology.yaml --yes
      - run: malha check infra/topology.yaml --fail-on none ${{ github.event.schedule == '30 11 * * 1' && '--digest' || '--notify' }}
        env:
          DISCORD_WEBHOOK_URL: ${{ secrets.DISCORD_WEBHOOK_URL }}
      - uses: actions/cache/save@v6
        if: always()
        with:
          path: infra/.malha/check-state.json
          key: malha-check-${{ github.run_id }}
```

Set the `DISCORD_WEBHOOK_URL` secret in the repository's settings (or `SLACK_WEBHOOK_URL`, with the slack plugin).

### On your machine

Vulnerabilities need the clones (`malha scan`), and `--live` needs the cluster, so those run where both are. A systemd user timer:

```ini
# ~/.config/systemd/user/malha-check.service
[Service]
Type=oneshot
WorkingDirectory=%h/infra-repo
ExecStart=/bin/sh -c 'malha scan infra/topology.yaml --code-dir %h/CODE && malha check infra/topology.yaml --live --notify --fail-on none'

# ~/.config/systemd/user/malha-check.timer
[Timer]
OnCalendar=*-*-* 08:00
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
systemctl --user enable --now malha-check.timer
```

Approve the plugins it uses once beforehand (`malha plugin allow kubernetes infra/topology.yaml`, and the notifier): a timer has no terminal to ask in, so anything not approved is refused. A crontab line running the same command works too.
