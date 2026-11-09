import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Ajv } from 'ajv'
import { scriptJson } from '../src/cli/build.ts'
import { loadTopology } from '../src/cli/load.ts'
import { compareVersions, findingsFrom, normalizeRemote } from '../src/cli/scan.ts'

describe('loadTopology', () => {
  it('loads the Acme example with only the expected warnings', () => {
    const { data, errors } = loadTopology('examples/acme/topology.yaml')
    expect(errors).toEqual([])
    expect(data?.meta.name).toBe('Acme')
  })

  it('names the item and field of a schema error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'malha-test-'))
    const file = join(dir, 'topology.yaml')
    writeFileSync(file, readFileSync('templates/topology.yaml', 'utf8').replace('memory_gib: 8', 'memory_gb: 8'))
    expect(loadTopology(file).errors).toEqual(['nodes[1] (web-1).hardware: unknown field "memory_gb"'])
  })

  it('reports YAML syntax errors instead of throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'malha-test-'))
    const file = join(dir, 'topology.yaml')
    writeFileSync(file, 'version: 1\nmeta: [unclosed\n')
    expect(loadTopology(file).errors.length).toBeGreaterThan(0)
  })
})

describe('scan helpers', () => {
  it.each([
    ['git@gitlab.com:group/sub/project.git', 'gitlab.com/group/sub/project'],
    ['https://github.com/Acme/Shop.git', 'github.com/acme/shop'],
    ['https://user@gitlab.example.com/a/b', 'gitlab.example.com/a/b'],
    ['ssh://git@gitlab.com:2222/a/b.git', 'gitlab.com:2222/a/b'],
  ])('normalizeRemote(%s)', (url, out) => expect(normalizeRemote(url)).toBe(out))

  it('orders versions numerically, pre-releases first', () => {
    const sorted = ['1.10.0', '1.2.0', '8.1.0.beta1', '8.1.0', '7.2.2.2'].sort(compareVersions)
    expect(sorted).toEqual(['1.2.0', '1.10.0', '7.2.2.2', '8.1.0.beta1', '8.1.0'])
  })

  it('picks the fix from the range the installed version is in', () => {
    const [f] = findingsFrom(
      {
        package: { name: 'actionview', version: '7.2.2.2', ecosystem: 'RubyGems' },
        groups: [{ ids: ['GHSA-x'], aliases: ['CVE-1'], max_severity: '6.1' }],
        vulnerabilities: [
          {
            id: 'GHSA-x',
            summary: 'XSS',
            affected: [
              { package: { name: 'actionview' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '8.1.0.beta1' }, { fixed: '8.1.2.1' }] }] },
              { package: { name: 'actionview' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '7.2.3.1' }] }] },
            ],
          },
        ],
      },
      'Gemfile.lock',
    )
    expect(f).toMatchObject({ severity: 'medium', score: 6.1, fixed: '7.2.3.1', ids: ['GHSA-x', 'CVE-1'] })
  })
})

describe('build', () => {
  it('escapes < so embedded JSON cannot close its script tag', () => {
    const tag = scriptJson('x', JSON.stringify({ note: '</script><script>alert(1)</script>' }))
    expect(tag).not.toContain('</script><script>')
    expect(JSON.parse(tag.slice(tag.indexOf('>') + 1, tag.lastIndexOf('</script>')))).toEqual({ note: '</script><script>alert(1)</script>' })
  })
})

describe('the schemas', () => {
  it('compile without warnings, so no command prints one', () => {
    for (const file of ['schema/topology.schema.json', 'schema/plugin.schema.json']) {
      const warnings: unknown[] = []
      new Ajv({ allErrors: true, logger: { log: () => undefined, warn: (...m: unknown[]) => warnings.push(m), error: (...m: unknown[]) => warnings.push(m) } }).compile(JSON.parse(readFileSync(file, 'utf8')))
      expect(warnings, file).toEqual([])
    }
  })
})
