import { describe, expect, it } from 'vitest'
import { registeredDomain } from '../src/core/hostnames.ts'
import type { Topology } from '../src/core/types.ts'
import { checkReferences } from '../src/core/validate.ts'

const base = (): Topology => ({
  version: 1,
  meta: { name: 'Test', checked: '2026-01-01' },
  providers: [{ id: 'porkbun', name: 'Porkbun', kind: 'saas' }],
  zones: [{ id: 'clients', name: 'Clients', column: 0 }, { id: 'servers', name: 'Servers', column: 1 }],
  nodes: [
    { id: 'internet', name: 'Internet', kind: 'users', zone: 'clients' },
    { id: 'web', name: 'web', kind: 'server', zone: 'servers', host: 'web.shop.example' },
  ],
  links: [{ from: 'internet', to: 'web', kind: 'http' }],
  apps: [{ id: 'shop', name: 'Shop', category: 'product', domains: ['shop.example', 'api.shop.example'], host: 'web' }],
  domains: { checked: '2026-01-01', list: [{ name: 'shop.example', registrar: 'porkbun', expires: '2027-01-01', auto_renew: true }] },
})

const today = new Date(2026, 0, 1)

describe('checkReferences', () => {
  it('accepts a consistent file', () => {
    expect(checkReferences(base(), today)).toEqual({ errors: [], warnings: [] })
  })

  it('names unknown zones, providers and link endpoints', () => {
    const t = base()
    t.nodes[1].zone = 'nowhere'
    t.nodes[1].provider = 'acme-cloud'
    t.links!.push({ from: 'web', to: 'db', kind: 'storage' })
    const { errors } = checkReferences(t, today)
    expect(errors).toContain('node web: zone "nowhere" is not defined')
    expect(errors).toContain('node web: provider "acme-cloud" is not defined')
    expect(errors.some((e) => e.includes('"db" is not a node or zone'))).toBe(true)
  })

  it('rejects duplicate ids and a node sharing an id with a zone', () => {
    const t = base()
    t.nodes.push({ id: 'web', name: 'again', kind: 'server', zone: 'servers' }, { id: 'servers', name: 'x', kind: 'server', zone: 'servers' })
    const { errors } = checkReferences(t, today)
    expect(errors).toContain('node "web" is defined twice')
    expect(errors.some((e) => e.includes('"servers" is both a node and a zone'))).toBe(true)
  })

  it('warns about a used domain that is not listed', () => {
    const t = base()
    t.apps![0].domains!.push('shop-cdn.example')
    expect(checkReferences(t, today).warnings).toContain('domain shop-cdn.example: used by app shop but not listed in domains')
  })

  it('warns when a domain in use is about to expire or will not renew', () => {
    const t = base()
    t.domains!.list[0] = { name: 'shop.example', registrar: 'porkbun', expires: '2026-01-21', auto_renew: false }
    const { warnings } = checkReferences(t, today)
    expect(warnings).toContain('domain shop.example: expires in 20 days and serves app shop, node web')
    expect(warnings).toContain('domain shop.example: serves app shop, node web and auto-renew is off')
  })

  it('warns when a domain in use has no expiry', () => {
    const t = base()
    t.domains!.list[0] = { name: 'shop.example' }
    expect(checkReferences(t, today).warnings[0]).toMatch(/expiry is not tracked/)
  })

  it('warns about a flow step with no link, unless it rides a network', () => {
    const t = base()
    t.flows = [{ id: 'f', name: 'f', kind: 'http', steps: [{ from: 'web', to: 'internet', label: 'ok' }, { from: 'internet', to: 'internet', label: 'x' }] }]
    expect(checkReferences(t, today).warnings).toEqual(['flow f step 2: no link between internet and internet; the viewer draws a dashed hop'])
  })
})

describe('registeredDomain', () => {
  it.each([
    ['api.acme.example', 'acme.example'],
    ['*.shop.example', 'shop.example'],
    ['shop.example', 'shop.example'],
    ['www.loja.com.br', 'loja.com.br'],
    ['a.b.example.co.uk', 'example.co.uk'],
    ['shop.com.au', 'shop.com.au'],
  ])('%s → %s', (host, domain) => expect(registeredDomain(host)).toBe(domain))
})
