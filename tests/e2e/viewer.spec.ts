import { execFileSync, type ChildProcess } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { CLI, collectErrors, copyExample, devServer, EXAMPLE, overflowing, staticServer } from './helpers.ts'

const TABS = [
  { name: 'Topology', ready: '.react-flow__node-infra' },
  { name: 'Map', ready: 'svg.map .map__site' },
  { name: 'Fleet', ready: '.rack' },
  { name: 'Products', ready: '.matrix tbody tr' },
  { name: 'Domains', ready: '.dom__row:not(.dom__row--head)' },
  { name: 'Traffic', ready: '.traffic h1' },
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

test('the Traffic tab shows every site, its trend, and what could not be read', async ({ page, isMobile }) => {
  const { dir, file } = copyExample()
  mkdirSync(join(dir, '.malha'))
  copyFileSync('tests/fixtures/analytics.json', join(dir, '.malha', 'analytics.json'))
  const port = isMobile ? 5417 : 5416
  const server = await devServer(file, port)
  try {
    const errors = collectErrors(page)
    await page.goto(`http://127.0.0.1:${port}/#traffic`)
    await expect(page.locator('.traffic h1')).toHaveText(/visitors across 3 sites in the last 30 days/)
    await expect(page.locator('.tsite:not(.tsite--head)')).toHaveCount(4)
    await expect(page.locator('.tsite:not(.tsite--head)').first()).toContainText('Shop')
    // The drop the checks flag is flagged here too.
    await expect(page.locator('.tsite', { hasText: 'Status page' }).locator('.delta--warn')).toBeVisible()
    await expect(page.locator('.tpanel--notice')).toContainText('no login for https://umami.acme.example')
    if (!isMobile) {
      const spark = await page.locator('.spark').first().boundingBox()
      await page.mouse.move(spark!.x + spark!.width / 2, spark!.y + spark!.height / 2)
      await expect(page.locator('.chart__tip').first()).toHaveText(/Oct \d+ · [\d,]+ visitors/)
    }
    expect(await overflowing(page)).toEqual([])

    // Another period: kept in the address.
    await page.getByRole('button', { name: '90 days' }).click()
    await expect(page.locator('.traffic h1')).toHaveText(/in the last 90 days/)
    await expect(page).toHaveURL(/#traffic\?p=90d$/)

    // A site's own page, in the same period, with links to each source's dashboard.
    await page.locator('.tsite', { hasText: 'Shop' }).click()
    await expect(page.locator('.traffic h1')).toHaveText('Shop')
    await expect(page).toHaveURL(/#traffic\/shop\?p=90d$/)
    await expect(page.locator('.tile', { hasText: 'Bounce rate' })).toContainText('41%')
    await expect(page.locator('.chart__legend').first()).toContainText('Last 90 days')
    await expect(page.locator('.tlinks .tlink').first()).toHaveAttribute('href', 'https://analytics.google.com/analytics/web/#/p312345678/reports/intelligenthome')
    await expect(page.locator('.tpanel', { hasText: 'Browsers' })).toContainText('Chrome')
    await expect(page.locator('table.matrix').first()).toContainText('acme kettle')
    await page.getByRole('button', { name: 'pageviews' }).click()
    await expect(page.locator('.tpanel--chart h2').first()).toHaveText('Pageviews per day')
    expect(await overflowing(page)).toEqual([])

    // Dates from the calendar, or dragged across the chart; the plugin-less copy can't fetch them.
    await page.getByRole('button', { name: 'Pick dates' }).click()
    await page.getByRole('button', { name: 'Last month' }).click()
    await expect(page.locator('.period__summary')).toHaveText(/ – .* · \d+ days, against the \d+ before/)
    await expect(page.locator('.cal__day.is-edge')).toHaveCount(2)
    expect(await overflowing(page)).toEqual([])
    await page.locator('.period__foot .btn').click()
    await expect(page.locator('.period__summary')).toHaveText(/no analytics plugin/)
    await page.getByRole('button', { name: 'Pick dates' }).click()
    if (!isMobile) {
      const plot = (await page.locator('.chart--compare .chart__plot').first().boundingBox())!
      await page.mouse.move(plot.x + plot.width * 0.2, plot.y + plot.height / 2)
      await page.mouse.down()
      await page.mouse.move(plot.x + plot.width * 0.5, plot.y + plot.height / 2, { steps: 4 })
      await expect(page.locator('.chart__band')).toBeVisible()
      await page.mouse.up()
      await expect(page.locator('.period__summary')).toHaveText(/^\w{3} \d+ – \w{3} \d+, 20\d\d · \d+ days/)
    }

    // Back to every site, and the app panel links to the page too.
    await page.goBack()
    await expect(page.locator('.traffic h1')).toHaveText(/in the last 90 days/)
    await page.locator('.tsite', { hasText: 'Status page' }).click()
    await page.getByRole('button', { name: 'Show its machines' }).click()
    await expect(page.locator('.insp__section', { hasText: 'Traffic · last 90 days' })).toContainText('Umami')
    await expect(page.locator('.insp__section a.tlink')).toHaveAttribute('href', 'https://umami.acme.example/websites/7b8f1c2e-5a44-4d1e-9c3a-2f6e8d0b1a55')
    // The one expected failure: the fetch refused above, which the browser logs.
    expect(errors.filter((e) => !e.includes('status of 409'))).toEqual([])
  } finally {
    server.kill()
  }
})

test('a static build carries the traffic', async ({ page, isMobile }) => {
  test.skip(isMobile, 'desktop covers it')
  const { dir, file } = copyExample()
  mkdirSync(join(dir, '.malha'))
  copyFileSync('tests/fixtures/analytics.json', join(dir, '.malha', 'analytics.json'))
  const out = join(dir, 'site')
  execFileSync(process.execPath, [CLI, 'build', file, '--out', out])
  const http = await staticServer(out, 5418)
  try {
    await page.goto('http://127.0.0.1:5418/#traffic')
    await expect(page.locator('.tsite:not(.tsite--head)')).toHaveCount(4)
  } finally {
    http.close()
  }
})
