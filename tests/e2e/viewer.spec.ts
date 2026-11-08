import { execFileSync, type ChildProcess } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { CLI, collectErrors, copyExample, devServer, EXAMPLE, overflowing, staticServer } from './helpers.ts'

const TABS = [
  { name: 'Topology', ready: '.react-flow__node-infra' },
  { name: 'Map', ready: 'svg.map .map__site' },
  { name: 'Fleet', ready: '.rack' },
  { name: 'Products', ready: '.matrix tbody tr' },
  { name: 'Domains', ready: '.dom__row:not(.dom__row--head)' },
  { name: 'Security', ready: '.security h1' },
]

test('every tab renders, with no console errors and nothing past the screen edge', async ({ page }) => {
  const errors = collectErrors(page)
  await page.goto('/')
  await expect(page).toHaveTitle('Acme · Malha')
  for (const tab of TABS) {
    await page.getByRole('button', { name: tab.name, exact: true }).click()
    await expect(page.locator(tab.ready).first()).toBeVisible()
    await page.waitForTimeout(400)
    expect(await overflowing(page), `${tab.name} overflows`).toEqual([])
  }
  await expect(page.locator('.security h1')).toHaveText('No scan yet')
  // The tab strip never slides under the search box.
  const overlap = await page.evaluate(() => {
    const tabs = document.querySelector('.tabs')!.getBoundingClientRect()
    const search = document.querySelector('.search')!.getBoundingClientRect()
    return tabs.top < search.bottom && search.top < tabs.bottom && tabs.right > search.left
  })
  expect(overlap).toBe(false)
  expect(errors).toEqual([])
})

test('the open tab survives a reload', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Domains', exact: true }).click()
  await expect(page).toHaveURL(/#domains$/)
  await page.reload()
  await expect(page.locator('.dom__row:not(.dom__row--head)').first()).toBeVisible()
})

test('a flow plays on the topology', async ({ page, isMobile }) => {
  await page.goto('/')
  if (isMobile) await page.getByRole('button', { name: 'Flows & layers' }).click()
  await page.getByRole('button', { name: /A customer places an order/ }).click()
  await expect(page.getByText('Now tracing')).toBeVisible()
  await expect(page.locator('.edge--active').first()).toBeAttached()
})

test('the map zooms with the controls', async ({ page }) => {
  await page.goto('/#map')
  await expect(page.locator('.map__zoom')).toHaveText('1.0×')
  await page.getByRole('button', { name: 'Zoom in' }).click()
  await expect(page.locator('.map__zoom')).not.toHaveText('1.0×')
  await expect(page.locator('.map__world')).toHaveAttribute('transform', /scale\((?!1\))/)
})

test.describe('serving a file', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop covers these')
  let server: ChildProcess | undefined
  test.afterEach(() => server?.kill())

  test('the page reloads when the file is saved', async ({ page }) => {
    const { file } = copyExample()
    server = await devServer(file, 5411)
    await page.goto('http://127.0.0.1:5411/')
    await expect(page).toHaveTitle('Acme · Malha')
    writeFileSync(file, readFileSync(file, 'utf8').replace('  name: Acme\n', '  name: Acme Labs\n'))
    await expect(page).toHaveTitle('Acme Labs · Malha', { timeout: 5000 })
  })

  test('an invalid file shows its errors in the page', async ({ page }) => {
    const { file } = copyExample()
    writeFileSync(file, readFileSync(file, 'utf8').replace('kind: worker\n', 'kind: wroker\n'))
    server = await devServer(file, 5412)
    await page.goto('http://127.0.0.1:5412/')
    await expect(page.locator('.fatal h1')).toContainText('is invalid')
    await expect(page.locator('.fatal li').first()).toContainText('nodes[7] (w1).kind')
  })

  test('a static build renders when served', async ({ page }) => {
    const { dir } = copyExample()
    const out = join(dir, 'site')
    execFileSync(process.execPath, [CLI, 'build', EXAMPLE, '--out', out])
    const http = await staticServer(out, 5413)
    try {
      const errors = collectErrors(page)
      await page.goto('http://127.0.0.1:5413/#fleet')
      await expect(page.locator('.rack').first()).toBeVisible()
      await expect(page).toHaveTitle('Acme · Malha')
      expect(errors).toEqual([])
    } finally {
      http.close()
    }
  })
})

test('a live plugin asks in the page, and its numbers replace the samples', async ({ page, isMobile }) => {
  const { file } = copyExample()
  execFileSync(process.execPath, [CLI, 'plugin', 'add', 'tests/fixtures/plugins/probe', file, '--yes'])
  const port = isMobile ? 5415 : 5414
  const server = await devServer(file, port)
  try {
    const errors = collectErrors(page)
    await page.goto(`http://127.0.0.1:${port}/#fleet`)
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toContainText('probe wants to run a program')
    await expect(dialog).toContainText('echo hello live')
    // Focus is on the dialog, not a button: Enter approves nothing.
    await page.keyboard.press('Enter')
    await expect(dialog).toBeVisible()
    await page.keyboard.press('1')
    await expect(dialog).toBeHidden()
    await expect(page.locator('.live__badge')).toHaveText(/live · \d+s ago/i)
    await expect(page.locator('.stat').filter({ hasText: 'Pods' })).toContainText(/live/i)
    // The badge shares the header without covering the tabs or the search box.
    const clash = await page.evaluate(() => {
      const r = (s: string) => document.querySelector(s)!.getBoundingClientRect()
      const hit = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
      return hit(r('.live'), r('.tabs')) || hit(r('.live'), r('.search'))
    })
    expect(clash).toBe(false)
    expect(await overflowing(page)).toEqual([])
    expect(errors).toEqual([])
  } finally {
    server.kill()
  }
})
