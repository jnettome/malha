#!/usr/bin/env node
// npm run release -- <version> [--push] [--skip-e2e]
// Checks, tests, bumps the version, turns "## Unreleased" into the version's changelog section,
// commits and tags. Pushing the tag publishes (see docs/releasing.md); this pushes only with --push.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const version = args.find((a) => !a.startsWith('--'))
const push = args.includes('--push')
const skipE2e = args.includes('--skip-e2e')

const fail = (message) => {
  console.error(`release: ${message}`)
  process.exit(1)
}
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim()
const run = (cmd, ...a) => {
  console.log(`\n$ ${cmd} ${a.join(' ')}`)
  execFileSync(cmd, a, { stdio: 'inherit' })
}
const parts = (v) => v.split(/[.-]/).slice(0, 3).map(Number)
const newer = (a, b) => {
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) fail('usage: npm run release -- <x.y.z> [--push] [--skip-e2e]')
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
if (!newer(version, pkg.version)) fail(`${version} is not newer than ${pkg.version}`)
const tag = `v${version}`

if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') fail('release from main')
if (git('status', '--porcelain')) fail('commit or stash your changes first')
git('fetch', '--quiet', '--tags', 'origin')
if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) fail('main differs from origin/main; pull or push first')
if (git('tag', '--list', tag)) fail(`${tag} already exists`)

const changelog = readFileSync('CHANGELOG.md', 'utf8')
const unreleased = changelog.match(/^## Unreleased\n([\s\S]*?)(?=^## |(?![\s\S]))/m)
if (!unreleased || !unreleased[1].trim()) fail('CHANGELOG.md needs a "## Unreleased" section saying what changed')

run('npm', 'run', 'typecheck')
run('npm', 'test')
run('npm', 'run', 'build')
if (!skipE2e) run('npm', 'run', 'e2e')

writeFileSync('CHANGELOG.md', changelog.replace(/^## Unreleased$/m, `## ${version}`))
run('npm', 'version', version, '--no-git-tag-version')
run('git', 'add', 'CHANGELOG.md', 'package.json', 'package-lock.json')
run('git', 'commit', '-m', `Release ${version}`)
run('git', 'tag', '-a', tag, '-m', `Malha ${version}`)

if (push) {
  run('git', 'push', 'origin', 'main', tag)
  console.log(`\nPushed ${tag}. Follow the Release workflow: gh run watch --repo jnettome/malha`)
} else {
  console.log(`\nCommitted and tagged ${tag}. Publish with:\n  git push origin main ${tag}`)
}
