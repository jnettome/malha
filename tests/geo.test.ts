import { describe, expect, it } from 'vitest'
import { arc, extentFor, placeLabels } from '../src/viewer/map/geo.ts'

describe('placeLabels', () => {
  it('stacks clustered labels in one column without overlap', () => {
    const size = { w: 168, h: 40 }
    const points = [
      { id: 'ny', at: [396, 306] as [number, number] },
      { id: 'oh', at: [331, 312] as [number, number] },
      { id: 'va', at: [352, 360] as [number, number] },
      { id: 'sp', at: [600, 780] as [number, number] },
    ]
    const labels = placeLabels(points, 1300, size)
    const cluster = labels.filter((l) => l.id !== 'sp')
    expect(new Set(cluster.map((l) => l.x)).size).toBe(1)
    const ys = cluster.map((l) => l.y).sort((a, b) => a - b)
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(size.h)
    // None of the cluster's labels covers a cluster marker.
    for (const l of cluster) for (const p of points.slice(0, 3)) expect(p.at[0] < l.x || p.at[0] > l.x + size.w).toBe(true)
  })
})

describe('arc', () => {
  it('bends both directions between two places to the same side', () => {
    const a = arc([0, 100], [100, 100], 0.2, true)
    const b = arc([100, 100], [0, 100], 0.2, false)
    expect(a.mid[1]).toBeCloseTo(b.mid[1])
    expect(a.mid[1]).toBeLessThan(100)
  })
})

describe('extentFor', () => {
  const site = (lat: number, lon: number) => ({ id: `${lat},${lon}`, name: 'x', lat, lon })
  it('fits the sites with padding', () => {
    const [[w, s], [e, n]] = extentFor([site(-23.5, -46.6), site(50.1, 8.7), site(39, -77.5)])
    expect(w).toBeLessThan(-77.5)
    expect(e).toBeGreaterThan(8.7)
    expect(s).toBeLessThan(-23.5)
    expect(n).toBeGreaterThan(50.1)
  })
  it('never zooms to a single city', () => {
    const [[w, s], [e, n]] = extentFor([site(50.5, 12.4)])
    expect(e - w).toBeGreaterThanOrEqual(70)
    expect(n - s).toBeGreaterThanOrEqual(40)
  })
})
