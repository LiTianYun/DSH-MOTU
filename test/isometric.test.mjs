/**
 * isometric 渲染器。
 *
 * 它是"扩展位"的第一个消费者，所以这里同时钉两件事：
 *   1. 渲染器自己的契约（两种 kind、取景、剖面、确定性、错误文案）；
 *   2. 扩展位真的够用 —— 断言产物合法 XML、取景不越界、限额可操作。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'

import { setupDom } from '../scripts/dom-env.mjs'
import { renderers } from '../lib/renderers/manifest.js'

const spec = renderers.find((item) => item.id === 'isometric')

function loadClient(t, theme = 'light') {
  const dom = setupDom({ scripts: true })
  dom.window.document.documentElement.dataset.theme = theme
  let client
  dom.window.__ModuleLoader__ = {
    load({ factory }) {
      client = factory(() => { throw new Error('no react needed') })
    },
  }
  dom.window.eval(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))
  t.after(() => dom.window.close())
  return { dom, client }
}

function env(client, overrides = {}) {
  return {
    loadEngine: async () => ({}),
    container: () => client.__dom.window.document.createElement('div'),
    clearContainer: () => {},
    theme: 'light',
    presentation: { fontFamily: 'system-ui, "Segoe UI", sans-serif', fontSize: 13 },
    settings: {},
    behaviour: {},
    limits: spec.limits,
    nextId: () => 'iso-test',
    ...overrides,
  }
}

/** 严格 XML 解析，返回问题描述（空串表示合法）。 */
function xmlProblem(dom, markup) {
  const parsed = new dom.window.DOMParser().parseFromString(markup, 'image/svg+xml')
  const error = parsed.querySelector('parsererror')
  if (error !== null) return String(error.textContent).replace(/\s+/g, ' ').trim().slice(0, 160)
  if (parsed.documentElement?.nodeName?.toLowerCase() === 'parsererror') return '根元素是 parsererror'
  return ''
}

/** 产物里所有路径点的屏幕包围盒（用于判断取景是否越界）。 */
function bbox(dom, markup) {
  const parsed = new dom.window.DOMParser().parseFromString(markup, 'image/svg+xml')
  const viewBox = parsed.documentElement.getAttribute('viewBox').split(/\s+/).map(Number)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const path of parsed.querySelectorAll('path')) {
    const d = path.getAttribute('d') ?? ''
    for (const match of d.matchAll(/(-?[\d.]+)\s+(-?[\d.]+)/g)) {
      const x = Number(match[1]); const y = Number(match[2])
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
      minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    }
  }
  return { viewBox, minX, minY, maxX, maxY }
}

const SOLID = JSON.stringify({
  kind: 'solid',
  title: '测试场景',
  desc: '说明',
  case: 2.2,
  cut: 0.7,
  objects: [
    { type: 'box', at: [0, 0, -1], size: [2, 2, 0.3], color: 'ink', label: '底座' },
    { type: 'ball', r: 0.5, color: 'blue' },
    { type: 'ring', at: [0, 0, 0.8], r: 1, count: 5, size: [0.2, 0.2, 0.2], color: 'purple' },
  ],
  callouts: [{ at: [0, 0, 0], text: '中心' }],
})

const VOXEL = JSON.stringify({
  kind: 'voxel',
  grid: 12,
  cut: true,
  title: '体素场景',
  desc: '说明',
  palette: { '#': 'amber', o: 'purple', '@': 'ink' },
  shapes: [
    { shape: 'shell', r: 5, thickness: 1.2, fill: '#' },
    { shape: 'cluster', count: 6, r: 4, fill: 'o', seed: 5 },
    { shape: 'ball', r: 1.2, fill: '@' },
  ],
  legend: [{ color: 'amber', text: '壳' }],
})

it('两种 kind 都能产出合法 XML 的图，且取景不越界', async (t) => {
  const { dom, client } = loadClient(t)
  for (const [label, source] of [['solid', SOLID], ['voxel', VOXEL]]) {
    const { markup } = await client.internals.ADAPTERS.isometric.render(source, env(client))
    assert.ok(markup.startsWith('<svg'), `${label} 应产出 SVG`)
    assert.equal(xmlProblem(dom, markup), '', `${label} 产物必须是合法 XML`)
    assert.match(markup, /<title>/, `${label} 必须带 title`)
    assert.match(markup, /<desc>/, `${label} 必须带 desc`)
    const box = bbox(dom, markup)
    const [vx, vy, vw, vh] = box.viewBox
    assert.ok(box.minX >= vx - 1 && box.minY >= vy - 1, `${label} 内容不得超出画布左上：${JSON.stringify(box)}`)
    assert.ok(box.maxX <= vx + vw + 1 && box.maxY <= vy + vh + 1, `${label} 内容不得超出画布右下：${JSON.stringify(box)}`)
  }
})

it('同一份 spec 两次渲染逐字节相同（确定性）', async (t) => {
  const { client } = loadClient(t)
  const first = await client.internals.ADAPTERS.isometric.render(SOLID, env(client))
  const second = await client.internals.ADAPTERS.isometric.render(SOLID, env(client))
  assert.equal(first.markup, second.markup, '含随机塌陷的场景也必须可复现')
  const voxelFirst = await client.internals.ADAPTERS.isometric.render(VOXEL, env(client))
  const voxelSecond = await client.internals.ADAPTERS.isometric.render(VOXEL, env(client))
  assert.equal(voxelFirst.markup, voxelSecond.markup)
})

it('剖面确实去掉一部分，且两种 kind 语义一致', async (t) => {
  const { client } = loadClient(t)
  const cut = await client.internals.ADAPTERS.isometric.render(SOLID, env(client))
  const whole = await client.internals.ADAPTERS.isometric.render(JSON.stringify({ ...JSON.parse(SOLID), cut: null }), env(client))
  const count = (markup) => (markup.match(/<path /g) ?? []).length
  assert.ok(count(cut.markup) < count(whole.markup), '剖切后路径数应减少')

  const voxelCut = await client.internals.ADAPTERS.isometric.render(VOXEL, env(client))
  const voxelWhole = await client.internals.ADAPTERS.isometric.render(JSON.stringify({ ...JSON.parse(VOXEL), cut: false }), env(client))
  assert.ok(count(voxelCut.markup) < count(voxelWhole.markup), '体素剖切同样应减少路径')
})

it('浅深主题取色不同', async (t) => {
  const light = loadClient(t, 'light')
  const lightOut = await light.client.internals.ADAPTERS.isometric.render(SOLID, env(light.client))
  const dark = loadClient(t, 'dark')
  const darkOut = await dark.client.internals.ADAPTERS.isometric.render(SOLID, env(dark.client))
  assert.notEqual(lightOut.markup, darkOut.markup, '深色主题应产出不同的取色')
  assert.match(lightOut.markup, /fill="#FFFFFF"/, '浅色画布底')
  assert.match(darkOut.markup, /fill="#1E1E1C"/, '深色画布底')
})

it('错误信息点名问题并给出可用值', async (t) => {
  const { client } = loadClient(t)
  const render = (value) => client.internals.ADAPTERS.isometric.render(JSON.stringify(value), env(client))
  await assert.rejects(() => render({ kind: '球体' }), /kind 未知.*solid \/ voxel/s)
  await assert.rejects(() => render({ kind: 'solid', objects: [] }), /objects 必须是非空数组/)
  await assert.rejects(() => render({ kind: 'solid', objects: [{ type: '金字塔' }] }), /type 未知.*box \/ ball \/ shell \/ cylinder \/ ring/s)
  await assert.rejects(() => render({ kind: 'solid', objects: [{ type: 'ball', r: '大' }] }), /r 必须是数字/)
  await assert.rejects(() => render({ kind: 'solid', objects: [{ type: 'box', size: [1, 1], color: 'blue' }] }), /size 必须是 \[x, y, z\]/)
  await assert.rejects(() => render({ kind: 'solid', objects: [{ type: 'ball', r: 1, color: 'chartreuse' }] }), /未知颜色：chartreuse/)
  await assert.rejects(() => render({ kind: 'voxel', grid: 12, palette: { '#': 'amber' } }), /需要 shapes 或 layers/)
  await assert.rejects(() => render({ kind: 'voxel', grid: 12, palette: { '#': 'amber' }, layers: ['#'], shapes: [] }), /二选一/)
  await assert.rejects(() => render({ kind: 'voxel', grid: 12, palette: { '#': 'amber' }, layers: ['x'] }), /未声明的字符/)
  await assert.rejects(() => render({ kind: 'voxel', grid: 12, palette: { ab: 'amber' }, shapes: [{ shape: 'ball', r: 1, fill: 'a' }] }), /必须是单个字符/)
})

it('限额：网格与面数超限时给出可操作建议', async (t) => {
  const { client } = loadClient(t)
  const render = (value, limits) => client.internals.ADAPTERS.isometric.render(JSON.stringify(value), env(client, { limits }))
  await assert.rejects(
    () => render({ kind: 'voxel', grid: 40, palette: { '#': 'amber' }, shapes: [{ shape: 'ball', r: 3, fill: '#' }] }),
    /体素网格边长超过上限 32（当前 40），请调小 grid/s,
  )
  await assert.rejects(
    () => render({ kind: 'solid', objects: [{ type: 'shell', r: 1.4, thickness: 0.2, segments: 40, rings: 24, color: 'amber' }] }, { faces: 100 }),
    /面数超过上限 100/,
  )
})

it('spec 过长时拒绝（进入对话的是它，产物是本地生成的）', async (t) => {
  const { client } = loadClient(t)
  const huge = JSON.stringify({ kind: 'solid', objects: [{ type: 'ball', r: 1, color: 'amber', note: 'x'.repeat(70_000) }] })
  await assert.rejects(
    () => client.internals.ADAPTERS.isometric.render(huge, env(client)),
    /spec 过长.*64 KiB/s,
  )
})

it('检测：只在明确声明 kind 时才认领无语言代码块', (t) => {
  const { client } = loadClient(t)
  const detect = client.internals.ADAPTERS.isometric.detect
  assert.equal(detect('{ "kind": "solid", "objects": [] }'), true)
  assert.equal(detect('{ "kind": "voxel", "grid": 8 }'), true)
  assert.equal(detect('{ "series": [{ "type": "bar" }] }'), false, '不能抢 ECharts 的 JSON')
  assert.equal(detect('flowchart TD\n A --> B'), false)
})

it('manifest 声明的限额与产物上限一致', () => {
  assert.ok(spec, 'manifest 应有 isometric 条目')
  assert.deepEqual(spec.languages, ['isometric', 'isometric-interactive'])
  assert.equal(spec.assets.length, 0, '自绘渲染器不 vendor 任何引擎')
  assert.ok(spec.limits.faces > 0 && spec.limits.grid > 0 && spec.limits.bytes > 64 * 1024, '产物上限应大于 spec 上限')
  assert.ok(spec.modes.some((mode) => mode.id === 'interactive' && mode.setting === 'interactive'), '交互模式要声明开关')
})
